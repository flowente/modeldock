import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Account, AccountStore, ApiKeyStore, Clock, StoredAccount, StoredApiKey } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";

/** Recognisable in a config file or a leaked log, like the prefixes of other providers. */
export const API_KEY_PREFIX = "mdk_";
const MAX_KEYS_PER_ACCOUNT = 25;
/** "Last used" moves at most once a minute, not on every call of a busy script. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface ApiKeySummary {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  owner: { id: string; displayName: string; email: string };
}

export interface CreatedApiKey {
  key: ApiKeySummary;
  /** The full key. Shown once: the server keeps only its hash. */
  secret: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string, message: string, httpStatus: number, suggestion?: string): never {
  throw new ModelDockError({ code, message, module: "api-keys", httpStatus, ...(suggestion ? { suggestion } : {}) });
}

/**
 * Keys for the OpenAI-compatible API. A key belongs to one account and can do with models
 * exactly what that account can: it carries no permissions of its own.
 */
export class ApiKeyService {
  private readonly keys: ApiKeyStore;
  private readonly accounts: AccountStore;
  private readonly clock: Clock;

  public constructor(keys: ApiKeyStore, accounts: AccountStore, clock: Clock) {
    this.keys = keys;
    this.accounts = accounts;
    this.clock = clock;
  }

  public async create(input: { account: Account; name: string }): Promise<CreatedApiKey> {
    const name = validateKeyName(input.name);
    if ((await this.keys.listApiKeys(input.account.id)).length >= MAX_KEYS_PER_ACCOUNT) {
      fail("API_KEY_LIMIT", `An account can have at most ${MAX_KEYS_PER_ACCOUNT} keys.`, 409, "Revoke a key you no longer use.");
    }
    const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const stored: StoredApiKey = {
      id: `key_${randomUUID()}`,
      userId: input.account.id,
      name,
      keyHash: sha256(secret),
      hint: `${API_KEY_PREFIX}…${secret.slice(-4)}`,
      createdAt: this.clock.now().toISOString()
    };
    await this.keys.insertApiKey(stored);
    return { key: summarize(stored, input.account), secret };
  }

  /** The account's own keys. */
  public async listOwn(account: Account): Promise<ApiKeySummary[]> {
    return (await this.keys.listApiKeys(account.id)).map((key) => summarize(key, account));
  }

  /** Every account's keys: for administrators. */
  public async listAll(): Promise<ApiKeySummary[]> {
    const owners = new Map((await this.accounts.listAccounts()).map((account) => [account.id, account]));
    return (await this.keys.listApiKeys()).flatMap((key) => {
      const owner = owners.get(key.userId);
      return owner ? [summarize(key, owner)] : [];
    });
  }

  /**
   * Revokes a key. Its owner can, and so can whoever manages accounts. To anyone else the key
   * does not exist: the answer must not confirm that an id is real.
   */
  public async revoke(input: { id: string; actor: Account; canManageAll: boolean }): Promise<void> {
    const key = await this.keys.findApiKeyById(input.id);
    if (!key || key.revokedAt || (key.userId !== input.actor.id && !input.canManageAll)) {
      fail("API_KEY_NOT_FOUND", "API key not found.", 404);
    }
    await this.keys.revokeApiKey(key.id, this.clock.now().toISOString());
  }

  /** The account behind a key, or undefined if the key is unknown, revoked, or its account is disabled. */
  public async authenticate(secret: string | undefined): Promise<{ account: Account; keyId: string } | undefined> {
    if (!secret || !secret.startsWith(API_KEY_PREFIX)) return undefined;
    const key = await this.keys.findApiKeyByHash(sha256(secret));
    if (!key || key.revokedAt) return undefined;
    const account = await this.accounts.findAccountById(key.userId);
    if (!account || account.status !== "active") return undefined;
    const now = this.clock.now();
    if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) >= TOUCH_INTERVAL_MS) {
      await this.keys.touchApiKey(key.id, now.toISOString());
    }
    return { account: withoutHash(account), keyId: key.id };
  }
}

function summarize(key: StoredApiKey, owner: Account): ApiKeySummary {
  return {
    id: key.id,
    name: key.name,
    hint: key.hint,
    createdAt: key.createdAt,
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    owner: { id: owner.id, displayName: owner.displayName, email: owner.email }
  };
}

function withoutHash(account: StoredAccount): Account {
  const { passwordHash: _passwordHash, ...rest } = account;
  return { ...rest, groupIds: [...rest.groupIds] };
}

function validateKeyName(value: unknown): string {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length === 0 || name.length > 60) fail("API_KEY_NAME_INVALID", "The key name must be between 1 and 60 characters.", 400);
  return name;
}
