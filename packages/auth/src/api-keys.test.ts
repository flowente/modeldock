import { describe, expect, it } from "vitest";
import { openDatabase, SqliteAccountStore, SqliteApiKeyStore } from "@modeldock/storage";
import { AccountService } from "./accounts.ts";
import { API_KEY_PREFIX, ApiKeyService } from "./api-keys.ts";

async function setup() {
  let now = new Date("2026-10-17T10:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const db = openDatabase(":memory:");
  const accountStore = new SqliteAccountStore(db);
  const accounts = new AccountService(accountStore, clock);
  const store = new SqliteApiKeyStore(db);
  const keys = new ApiKeyService(store, accountStore, clock);
  const admin = (await accounts.setupFirstAdmin({ email: "simone@example.com", displayName: "Simone", password: "una-password-lunga" })).account;
  const invite = await accounts.createInvitation({ email: "anna@example.com", displayName: "Anna", createdBy: admin.id });
  const member = (await accounts.acceptInvitation({ token: invite.token, password: "password-di-anna" })).account;
  return { db, store, accounts, keys, admin, member, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("ApiKeyService", () => {
  it("shows the key once and stores only its hash", async () => {
    const { db, keys, admin } = await setup();
    const created = await keys.create({ account: admin, name: "  Script n8n  " });
    expect(created.secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.key).toMatchObject({ name: "Script n8n", hint: `${API_KEY_PREFIX}…${created.secret.slice(-4)}`, owner: { id: admin.id } });
    expect(created.key).not.toHaveProperty("keyHash");
    const dump = JSON.stringify(db.prepare("SELECT * FROM api_keys").all());
    expect(dump).not.toContain(created.secret);
  });

  it("authenticates a key as its account, and nothing else", async () => {
    const { keys, member } = await setup();
    const { secret, key } = await keys.create({ account: member, name: "laptop" });
    expect(await keys.authenticate(secret)).toMatchObject({ account: { id: member.id, role: "member" }, keyId: key.id });
    expect(await keys.authenticate(`${secret}x`)).toBeUndefined();
    expect(await keys.authenticate("sk-qualcosa")).toBeUndefined();
    expect(await keys.authenticate(undefined)).toBeUndefined();
    expect(await keys.authenticate(secret)).not.toHaveProperty("account.passwordHash");
  });

  it("records last use at most once a minute", async () => {
    const { keys, store, admin, advance } = await setup();
    const { secret, key } = await keys.create({ account: admin, name: "a" });
    await keys.authenticate(secret);
    const first = (await store.findApiKeyById(key.id))?.lastUsedAt;
    expect(first).toBe("2026-10-17T10:00:00.000Z");
    advance(30_000);
    await keys.authenticate(secret);
    expect((await store.findApiKeyById(key.id))?.lastUsedAt).toBe(first);
    advance(30_000);
    await keys.authenticate(secret);
    expect((await store.findApiKeyById(key.id))?.lastUsedAt).toBe("2026-10-17T10:01:00.000Z");
  });

  it("a revoked key stops working and leaves the list", async () => {
    const { keys, admin } = await setup();
    const { secret, key } = await keys.create({ account: admin, name: "a" });
    await keys.revoke({ id: key.id, actor: admin, canManageAll: false });
    expect(await keys.authenticate(secret)).toBeUndefined();
    expect(await keys.listOwn(admin)).toEqual([]);
    await expect(keys.revoke({ id: key.id, actor: admin, canManageAll: false })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
  });

  it("only the owner or an administrator can revoke; others are told the key does not exist", async () => {
    const { keys, admin, member } = await setup();
    const own = await keys.create({ account: admin, name: "admin" });
    await expect(keys.revoke({ id: own.key.id, actor: member, canManageAll: false })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND", httpStatus: 404 });
    const theirs = await keys.create({ account: member, name: "member" });
    await keys.revoke({ id: theirs.key.id, actor: admin, canManageAll: true });
    expect(await keys.authenticate(theirs.secret)).toBeUndefined();
  });

  it("a disabled or deleted account takes its keys down with it", async () => {
    const { accounts, keys, member } = await setup();
    const { secret } = await keys.create({ account: member, name: "a" });
    await accounts.updateAccount(member.id, { status: "disabled" });
    expect(await keys.authenticate(secret)).toBeUndefined();
    await accounts.updateAccount(member.id, { status: "active" });
    expect(await keys.authenticate(secret)).toBeDefined();
    await accounts.deleteAccount(member.id);
    expect(await keys.authenticate(secret)).toBeUndefined();
  });

  it("lists own keys newest first; administrators can list everyone's with the owner", async () => {
    const { keys, admin, member, advance } = await setup();
    await keys.create({ account: member, name: "prima" });
    advance(1000);
    await keys.create({ account: member, name: "seconda" });
    await keys.create({ account: admin, name: "admin" });
    expect((await keys.listOwn(member)).map((key) => key.name)).toEqual(["seconda", "prima"]);
    const all = await keys.listAll();
    expect(all).toHaveLength(3);
    expect(all.find((key) => key.name === "prima")?.owner).toEqual({ id: member.id, displayName: "Anna", email: "anna@example.com" });
  });

  it("validates the name and caps the number of keys", async () => {
    const { keys, admin } = await setup();
    await expect(keys.create({ account: admin, name: "   " })).rejects.toMatchObject({ code: "API_KEY_NAME_INVALID", httpStatus: 400 });
    await expect(keys.create({ account: admin, name: "x".repeat(61) })).rejects.toMatchObject({ code: "API_KEY_NAME_INVALID" });
    for (let index = 0; index < 25; index += 1) await keys.create({ account: admin, name: `k${index}` });
    await expect(keys.create({ account: admin, name: "troppe" })).rejects.toMatchObject({ code: "API_KEY_LIMIT", httpStatus: 409 });
  });
});
