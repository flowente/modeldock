import { describe, expect, it } from "vitest";
import { openDatabase, SqliteAccountStore, SqliteModelAccessStore } from "@modeldock/storage";
import { canUseModel } from "@modeldock/core";
import { AccountService, hashPassword, verifyPassword } from "./accounts.ts";

function setup() {
  let now = new Date("2026-10-15T10:00:00.000Z");
  const db = openDatabase(":memory:");
  const store = new SqliteAccountStore(db);
  const service = new AccountService(store, { now: () => new Date(now) });
  return { db, store, service, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const admin = { email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" };

describe("password", () => {
  it("is never stored in clear and verifies only the right one", async () => {
    const hash = await hashPassword("segreto-123");
    expect(hash).not.toContain("segreto-123");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("segreto-123", hash)).toBe(true);
    expect(await verifyPassword("segreto-124", hash)).toBe(false);
  });
});

describe("AccountService", () => {
  it("creates the first administrator once, then refuses", async () => {
    const { service } = setup();
    expect(await service.needsSetup()).toBe(true);
    const session = await service.setupFirstAdmin(admin);
    expect(session.account).toMatchObject({ role: "admin", status: "active", email: admin.email });
    expect(session.account).not.toHaveProperty("passwordHash");
    expect(await service.needsSetup()).toBe(false);
    await expect(service.setupFirstAdmin({ ...admin, email: "altro@example.com" })).rejects.toMatchObject({ code: "ACCOUNT_SETUP_DONE", httpStatus: 409 });
  });

  it("logs in with the right password, ignoring email case; one generic error otherwise", async () => {
    const { service } = setup();
    await service.setupFirstAdmin(admin);
    const session = await service.login({ email: "SIMONE@example.com", password: admin.password });
    expect(session.token.length).toBeGreaterThan(30);

    await expect(service.login({ email: admin.email, password: "sbagliata-123" })).rejects.toMatchObject({ code: "ACCOUNT_LOGIN_FAILED", httpStatus: 401 });
    await expect(service.login({ email: "nessuno@example.com", password: admin.password })).rejects.toMatchObject({ code: "ACCOUNT_LOGIN_FAILED", httpStatus: 401 });
  });

  it("a session token identifies the account until logout or expiry", async () => {
    const { service, advance } = setup();
    const { token } = await service.setupFirstAdmin(admin);
    expect((await service.authenticate(token))?.account.email).toBe(admin.email);
    expect(await service.authenticate("inventato")).toBeUndefined();

    await service.logout(token);
    expect(await service.authenticate(token)).toBeUndefined();

    const second = await service.login({ email: admin.email, password: admin.password });
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await service.authenticate(second.token)).toBeUndefined();
  });

  it("stores only hashes of session and invitation tokens", async () => {
    const { service, db } = setup();
    const { token, account } = await service.setupFirstAdmin(admin);
    const invite = await service.createInvitation({ email: "anna@example.com", displayName: "Anna", createdBy: account.id });
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM sessions").all(),
      db.prepare("SELECT * FROM invitations").all(),
      db.prepare("SELECT * FROM users").all()
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(invite.token);
    expect(dump).not.toContain(admin.password);
  });

  it("an invitation creates the account once, with its role and groups", async () => {
    const { service } = setup();
    const { account } = await service.setupFirstAdmin(admin);
    const team = await service.createGroup({ name: "Team" });
    const { token } = await service.createInvitation({
      email: "anna@example.com",
      displayName: "Anna",
      role: "member",
      groupIds: [team.id],
      createdBy: account.id
    });

    expect(await service.previewInvitation(token)).toMatchObject({ email: "anna@example.com", displayName: "Anna" });
    const anna = await service.acceptInvitation({ token, password: "password-di-anna" });
    expect(anna.account).toMatchObject({ role: "member", groupIds: [team.id] });
    await expect(service.acceptInvitation({ token, password: "password-di-anna" })).rejects.toMatchObject({ code: "INVITATION_USED", httpStatus: 410 });
    await expect(service.login({ email: "anna@example.com", password: "password-di-anna" })).resolves.toBeDefined();
  });

  it("expired invitations and weak passwords are refused", async () => {
    const { service, advance } = setup();
    const { account } = await service.setupFirstAdmin(admin);
    const { token } = await service.createInvitation({ email: "b@example.com", displayName: "B", createdBy: account.id, ttlHours: 1 });
    await expect(service.acceptInvitation({ token, password: "corta" })).rejects.toMatchObject({ code: "ACCOUNT_PASSWORD_WEAK" });
    advance(2 * 60 * 60 * 1000);
    await expect(service.acceptInvitation({ token, password: "abbastanza-lunga" })).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });

  it("never leaves ModelDock without an active administrator", async () => {
    const { service } = setup();
    const { account } = await service.setupFirstAdmin(admin);
    await expect(service.updateAccount(account.id, { role: "member" })).rejects.toMatchObject({ code: "ACCOUNT_LAST_ADMIN" });
    await expect(service.updateAccount(account.id, { status: "disabled" })).rejects.toMatchObject({ code: "ACCOUNT_LAST_ADMIN" });
    await expect(service.deleteAccount(account.id)).rejects.toMatchObject({ code: "ACCOUNT_LAST_ADMIN" });

    const { token } = await service.createInvitation({ email: "c@example.com", displayName: "C", role: "admin", createdBy: account.id });
    await service.acceptInvitation({ token, password: "un'altra-password" });
    await expect(service.updateAccount(account.id, { role: "member" })).resolves.toMatchObject({ role: "member" });
  });

  it("disabling an account ends its sessions at once", async () => {
    const { service } = setup();
    const { account } = await service.setupFirstAdmin(admin);
    const { token } = await service.createInvitation({ email: "d@example.com", displayName: "D", createdBy: account.id });
    const d = await service.acceptInvitation({ token, password: "password-di-d" });
    await service.updateAccount(d.account.id, { status: "disabled" });
    expect(await service.authenticate(d.token)).toBeUndefined();
    await expect(service.login({ email: "d@example.com", password: "password-di-d" })).rejects.toMatchObject({ code: "ACCOUNT_LOGIN_FAILED" });
  });

  it("changing the password keeps this session and closes the others", async () => {
    const { service } = setup();
    const first = await service.setupFirstAdmin(admin);
    const other = await service.login({ email: admin.email, password: admin.password });
    const current = await service.authenticate(first.token);
    await service.changePassword({
      accountId: first.account.id,
      currentPassword: admin.password,
      newPassword: "nuova-password-123",
      keepSessionIdHash: current!.idHash
    });
    expect(await service.authenticate(first.token)).toBeDefined();
    expect(await service.authenticate(other.token)).toBeUndefined();
    await expect(service.login({ email: admin.email, password: "nuova-password-123" })).resolves.toBeDefined();
  });

  it("group names are unique regardless of case", async () => {
    const { service } = setup();
    await service.createGroup({ name: "Clienti" });
    await expect(service.createGroup({ name: "clienti" })).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN", httpStatus: 409 });
  });
});

describe("model permissions on the real database", () => {
  it("a new model is usable only by administrators until it is granted", async () => {
    const { db, service } = setup();
    const access = new SqliteModelAccessStore(db);
    const { account } = await service.setupFirstAdmin(admin);
    const team = await service.createGroup({ name: "Team" });
    const { token } = await service.createInvitation({ email: "e@example.com", displayName: "E", groupIds: [team.id], createdBy: account.id });
    const e = (await service.acceptInvitation({ token, password: "password-di-e" })).account;

    const policy = await access.ensurePolicy("gpt-oss:20b");
    const asAdmin = { userId: account.id, role: account.role, groupIds: account.groupIds };
    const asMember = { userId: e.id, role: e.role, groupIds: e.groupIds };
    expect(canUseModel(policy, asAdmin)).toBe(true);
    expect(canUseModel(policy, asMember)).toBe(false);

    const granted = await access.updatePolicy({ modelName: "gpt-oss:20b", groupGrants: { [team.id]: true } });
    expect(canUseModel(granted, asMember)).toBe(true);

    const disabled = await access.updatePolicy({ modelName: "gpt-oss:20b", enabled: false });
    expect(canUseModel(disabled, asAdmin)).toBe(false);
  });

  it("a single account can be granted a model on top of its groups", async () => {
    const { db, service } = setup();
    const access = new SqliteModelAccessStore(db);
    const { account } = await service.setupFirstAdmin(admin);
    const { token } = await service.createInvitation({ email: "f@example.com", displayName: "F", createdBy: account.id });
    const f = (await service.acceptInvitation({ token, password: "password-di-f" })).account;
    const policy = await access.setUserGrant("phi3:3.8b", f.id, true);
    expect(canUseModel(policy, { userId: f.id, role: "member", groupIds: [] })).toBe(true);
  });

  it("deleting a group removes its grants and memberships", async () => {
    const { db, service } = setup();
    const access = new SqliteModelAccessStore(db);
    const group = await service.createGroup({ name: "Temporaneo" });
    await access.ensurePolicy("phi3:3.8b");
    await access.updatePolicy({ modelName: "phi3:3.8b", groupGrants: { [group.id]: true } });
    await service.deleteGroup(group.id);
    expect((await access.listPolicies())[0]?.grants).toEqual([]);
  });

  it("survives a restart when the database is a file", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "modeldock-db-"));
    const path = join(dir, "modeldock.db");
    try {
      const first = openDatabase(path);
      await new AccountService(new SqliteAccountStore(first), { now: () => new Date() }).setupFirstAdmin(admin);
      first.close();
      const second = openDatabase(path);
      const service = new AccountService(new SqliteAccountStore(second), { now: () => new Date() });
      expect(await service.needsSetup()).toBe(false);
      await expect(service.login({ email: admin.email, password: admin.password })).resolves.toBeDefined();
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
