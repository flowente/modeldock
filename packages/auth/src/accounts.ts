import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Account, AccountStore, Clock, Role, StoredAccount, StoredGroup, StoredInvitation } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session in use is extended at most once an hour, not on every request. */
const SESSION_REFRESH_MS = 60 * 60 * 1000;
const DEFAULT_INVITATION_TTL_HOURS = 72;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

const SCRYPT = { N: 32_768, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function fail(code: string, message: string, httpStatus: number, suggestion?: string): never {
  throw new ModelDockError({ code, message, module: "accounts", httpStatus, ...(suggestion ? { suggestion } : {}) });
}

export interface IssuedSession {
  /** Goes in the cookie and nowhere else. The server keeps only its hash. */
  token: string;
  expiresAt: string;
  account: Account;
}

export interface CreatedInvitation {
  invitation: InvitationSummary;
  /** Shown once, inside the invitation link. */
  token: string;
}

export interface InvitationSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  groupIds: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface AccountUpdate {
  displayName?: string;
  role?: Role;
  status?: "active" | "disabled";
  groupIds?: string[];
}

export class AccountService {
  private readonly store: AccountStore;
  private readonly clock: Clock;
  /** Used to spend the same time on an unknown email as on a wrong password. */
  private readonly decoyHash: Promise<string>;

  public constructor(store: AccountStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
    this.decoyHash = hashPassword(randomBytes(16).toString("hex"));
  }

  public async needsSetup(): Promise<boolean> {
    return (await this.store.countAccounts()) === 0;
  }

  /** The very first account. Only possible while no account exists. */
  public async setupFirstAdmin(input: { email: string; displayName: string; password: string; userAgent?: string }): Promise<IssuedSession> {
    if (!(await this.needsSetup())) {
      fail("ACCOUNT_SETUP_DONE", "ModelDock already has an administrator.", 409, "Sign in with an existing account.");
    }
    const account = await this.insertAccount({
      email: input.email,
      displayName: input.displayName,
      password: input.password,
      role: "admin",
      groupIds: []
    });
    return this.issueSession(account, input.userAgent);
  }

  public async login(input: { email: string; password: string; userAgent?: string }): Promise<IssuedSession> {
    const account = await this.store.findAccountByEmail(input.email);
    const hash = account?.passwordHash ?? (await this.decoyHash);
    const valid = await verifyPassword(String(input.password), hash);
    // One answer for every failure: whoever tries cannot learn which emails exist.
    if (!account || !valid || account.status !== "active") {
      fail("ACCOUNT_LOGIN_FAILED", "Email or password is not correct.", 401);
    }
    const now = this.clock.now().toISOString();
    await this.store.updateAccount(account.id, { lastLoginAt: now, updatedAt: now });
    return this.issueSession({ ...account, lastLoginAt: now }, input.userAgent);
  }

  /** The account behind a session token, or undefined if the session is missing, expired or disabled. */
  public async authenticate(token: string | undefined): Promise<{ account: Account; idHash: string } | undefined> {
    if (!token) return undefined;
    const idHash = sha256(token);
    const session = await this.store.findSession(idHash);
    if (!session) return undefined;
    const now = this.clock.now();
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      await this.store.deleteSession(idHash);
      return undefined;
    }
    const account = await this.store.findAccountById(session.userId);
    if (!account || account.status !== "active") return undefined;
    if (now.getTime() - Date.parse(session.lastSeenAt) >= SESSION_REFRESH_MS) {
      await this.store.touchSession(idHash, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
    }
    return { account: publicAccount(account), idHash };
  }

  public async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.deleteSession(sha256(token));
  }

  /** Changes the password and signs out every other session of the account. */
  public async changePassword(input: { accountId: string; currentPassword: string; newPassword: string; keepSessionIdHash?: string }): Promise<void> {
    const account = await this.requireAccount(input.accountId);
    if (!account.passwordHash || !(await verifyPassword(String(input.currentPassword), account.passwordHash))) {
      fail("ACCOUNT_PASSWORD_WRONG", "The current password is not correct.", 403);
    }
    const passwordHash = await hashPassword(validatePassword(input.newPassword, account.email));
    await this.store.updateAccount(account.id, { passwordHash, updatedAt: this.clock.now().toISOString() });
    await this.store.deleteSessionsForUser(account.id, input.keepSessionIdHash);
  }

  public async listAccounts(): Promise<Account[]> {
    return (await this.store.listAccounts()).map(publicAccount);
  }

  public async updateAccount(id: string, update: AccountUpdate): Promise<Account> {
    const account = await this.requireAccount(id);
    const losesAdmin =
      account.role === "admin" && account.status === "active" && ((update.role !== undefined && update.role !== "admin") || update.status === "disabled");
    if (losesAdmin) await this.assertAnotherActiveAdmin(id);
    if (update.groupIds) await this.assertGroupsExist(update.groupIds);

    await this.store.updateAccount(id, {
      ...(update.displayName !== undefined ? { displayName: validateDisplayName(update.displayName) } : {}),
      ...(update.role !== undefined ? { role: validateRole(update.role) } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.groupIds ? { groupIds: update.groupIds } : {}),
      updatedAt: this.clock.now().toISOString()
    });
    if (update.status === "disabled") await this.store.deleteSessionsForUser(id);
    return publicAccount(await this.requireAccount(id));
  }

  public async deleteAccount(id: string): Promise<void> {
    const account = await this.requireAccount(id);
    if (account.role === "admin" && account.status === "active") await this.assertAnotherActiveAdmin(id);
    await this.store.deleteAccount(id);
  }

  public async listGroups(): Promise<StoredGroup[]> {
    return this.store.listGroups();
  }

  public async createGroup(input: { name: string; description?: string }): Promise<StoredGroup> {
    const name = validateGroupName(input.name);
    if ((await this.store.listGroups()).some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      fail("GROUP_NAME_TAKEN", `A group named "${name}" already exists.`, 409);
    }
    const description = input.description?.trim();
    const group: StoredGroup = {
      id: `grp_${randomUUID()}`,
      name,
      ...(description ? { description } : {}),
      createdAt: this.clock.now().toISOString()
    };
    await this.store.insertGroup(group);
    return group;
  }

  public async updateGroup(id: string, input: { name?: string; description?: string | null }): Promise<StoredGroup> {
    await this.requireGroup(id);
    const name = input.name === undefined ? undefined : validateGroupName(input.name);
    if (name && (await this.store.listGroups()).some((group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) {
      fail("GROUP_NAME_TAKEN", `A group named "${name}" already exists.`, 409);
    }
    await this.store.updateGroup(id, {
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {})
    });
    return this.requireGroup(id);
  }

  public async deleteGroup(id: string): Promise<void> {
    await this.requireGroup(id);
    await this.store.deleteGroup(id);
  }

  public async createInvitation(input: {
    email: string;
    displayName: string;
    role?: Role;
    groupIds?: string[];
    createdBy: string;
    ttlHours?: number;
  }): Promise<CreatedInvitation> {
    const email = validateEmail(input.email);
    if (await this.store.findAccountByEmail(email)) {
      fail("ACCOUNT_EMAIL_TAKEN", `An account with ${email} already exists.`, 409);
    }
    const groupIds = input.groupIds ?? [];
    await this.assertGroupsExist(groupIds);
    const ttlHours = input.ttlHours ?? DEFAULT_INVITATION_TTL_HOURS;
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) {
      fail("INVITATION_TTL_INVALID", "An invitation lasts between one hour and 30 days.", 400);
    }
    const now = this.clock.now();
    const token = newToken();
    const invitation: StoredInvitation = {
      id: `inv_${randomUUID()}`,
      tokenHash: sha256(token),
      email,
      displayName: validateDisplayName(input.displayName),
      role: validateRole(input.role ?? "member"),
      groupIds,
      createdBy: input.createdBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString()
    };
    await this.store.insertInvitation(invitation);
    return { invitation: summarizeInvitation(invitation), token };
  }

  public async listInvitations(): Promise<InvitationSummary[]> {
    return (await this.store.listInvitations()).map(summarizeInvitation);
  }

  public async revokeInvitation(id: string): Promise<void> {
    await this.store.deleteInvitation(id);
  }

  /** What the invited person sees before choosing a password. */
  public async previewInvitation(token: string): Promise<{ email: string; displayName: string; expiresAt: string }> {
    const invitation = await this.requireUsableInvitation(token);
    return { email: invitation.email, displayName: invitation.displayName, expiresAt: invitation.expiresAt };
  }

  public async acceptInvitation(input: { token: string; password: string; userAgent?: string }): Promise<IssuedSession> {
    const invitation = await this.requireUsableInvitation(input.token);
    const password = validatePassword(input.password, invitation.email);
    if (!(await this.store.consumeInvitation(invitation.id, this.clock.now().toISOString()))) {
      fail("INVITATION_USED", "This invitation has already been used.", 410, "Ask for a new invitation.");
    }
    const account = await this.insertAccount({
      email: invitation.email,
      displayName: invitation.displayName,
      password,
      role: invitation.role,
      groupIds: invitation.groupIds.filter(Boolean)
    });
    return this.issueSession(account, input.userAgent);
  }

  public async pruneExpiredSessions(): Promise<void> {
    await this.store.deleteExpiredSessions(this.clock.now().toISOString());
  }

  private async insertAccount(input: { email: string; displayName: string; password: string; role: Role; groupIds: string[] }): Promise<StoredAccount> {
    const email = validateEmail(input.email);
    if (await this.store.findAccountByEmail(email)) {
      fail("ACCOUNT_EMAIL_TAKEN", `An account with ${email} already exists.`, 409);
    }
    const existingGroups = new Set((await this.store.listGroups()).map((group) => group.id));
    const now = this.clock.now().toISOString();
    const account: StoredAccount = {
      id: `usr_${randomUUID()}`,
      email,
      displayName: validateDisplayName(input.displayName),
      role: validateRole(input.role),
      status: "active",
      // A group deleted between invitation and acceptance is simply left out.
      groupIds: input.groupIds.filter((id) => existingGroups.has(id)),
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      passwordHash: await hashPassword(validatePassword(input.password, email))
    };
    await this.store.insertAccount(account);
    return account;
  }

  private async issueSession(account: StoredAccount, userAgent?: string): Promise<IssuedSession> {
    const token = newToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await this.store.insertSession({
      idHash: sha256(token),
      userId: account.id,
      createdAt: now.toISOString(),
      expiresAt,
      lastSeenAt: now.toISOString(),
      ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {})
    });
    return { token, expiresAt, account: publicAccount(account) };
  }

  private async requireUsableInvitation(token: string): Promise<StoredInvitation> {
    const invitation = await this.store.findInvitationByTokenHash(sha256(String(token)));
    if (!invitation) fail("INVITATION_INVALID", "This invitation link is not valid.", 404);
    if (invitation.usedAt) fail("INVITATION_USED", "This invitation has already been used.", 410, "Ask for a new invitation.");
    if (Date.parse(invitation.expiresAt) <= this.clock.now().getTime()) {
      fail("INVITATION_EXPIRED", "This invitation has expired.", 410, "Ask for a new invitation.");
    }
    return invitation;
  }

  private async requireAccount(id: string): Promise<StoredAccount> {
    const account = await this.store.findAccountById(id);
    if (!account) fail("ACCOUNT_NOT_FOUND", "Account not found.", 404);
    return account;
  }

  private async requireGroup(id: string): Promise<StoredGroup> {
    const group = await this.store.findGroupById(id);
    if (!group) fail("GROUP_NOT_FOUND", "Group not found.", 404);
    return group;
  }

  private async assertGroupsExist(groupIds: string[]): Promise<void> {
    const existing = new Set((await this.store.listGroups()).map((group) => group.id));
    const missing = groupIds.filter((id) => !existing.has(id));
    if (missing.length > 0) fail("GROUP_NOT_FOUND", `Unknown group: ${missing.join(", ")}.`, 400);
  }

  /** ModelDock must never be left without an active administrator. */
  private async assertAnotherActiveAdmin(exceptId: string): Promise<void> {
    const others = (await this.store.listAccounts()).filter((account) => account.id !== exceptId && account.role === "admin" && account.status === "active");
    if (others.length === 0) {
      fail("ACCOUNT_LAST_ADMIN", "This is the only active administrator.", 409, "Make another account an administrator first.");
    }
  }
}

function publicAccount(account: StoredAccount): Account {
  const { passwordHash: _passwordHash, ...rest } = account;
  return { ...rest, groupIds: [...rest.groupIds] };
}

function summarizeInvitation(invitation: StoredInvitation): InvitationSummary {
  const { tokenHash: _tokenHash, ...rest } = invitation;
  return { ...rest, groupIds: [...rest.groupIds] };
}

const ROLES: Role[] = ["admin", "operator", "viewer", "member"];

function validateRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) fail("ACCOUNT_ROLE_INVALID", `Unknown role: ${String(role)}.`, 400);
  return role as Role;
}

function validateEmail(value: unknown): string {
  const email = String(value ?? "").trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("ACCOUNT_EMAIL_INVALID", "Enter a valid email address.", 400);
  }
  return email;
}

function validateDisplayName(value: unknown): string {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length === 0 || name.length > 80) fail("ACCOUNT_NAME_INVALID", "The name must be between 1 and 80 characters.", 400);
  return name;
}

function validateGroupName(value: unknown): string {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length === 0 || name.length > 60) fail("GROUP_NAME_INVALID", "The group name must be between 1 and 60 characters.", 400);
  return name;
}

function validatePassword(value: unknown, email: string): string {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    fail("ACCOUNT_PASSWORD_WEAK", `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`, 400);
  }
  if (password.toLowerCase() === email.toLowerCase()) {
    fail("ACCOUNT_PASSWORD_WEAK", "The password cannot be the email address.", 400);
  }
  return password;
}
