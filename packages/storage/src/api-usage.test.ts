import { describe, expect, it } from "vitest";
import type { ApiUsageEntry } from "@modeldock/core";
import { openDatabase } from "./database.ts";
import { SqliteAccountStore, SqliteApiKeyStore, SqliteApiUsageStore } from "./sqlite-stores.ts";

async function setup() {
  const db = openDatabase(":memory:");
  const now = "2026-10-17T10:00:00.000Z";
  await new SqliteAccountStore(db).insertAccount({
    id: "usr_1",
    email: "a@example.com",
    displayName: "A",
    role: "admin",
    status: "active",
    groupIds: [],
    createdAt: now,
    updatedAt: now
  });
  const keys = new SqliteApiKeyStore(db);
  for (const id of ["key_a", "key_b"]) await keys.insertApiKey({ id, userId: "usr_1", name: id, keyHash: id, hint: "mdk_…", createdAt: now });
  return { db, keys, usage: new SqliteApiUsageStore(db) };
}

const call = (overrides: Partial<ApiUsageEntry>): ApiUsageEntry => ({
  keyId: "key_a",
  model: "gemma3:270m",
  endpoint: "chat",
  status: 200,
  streamed: false,
  promptTokens: 10,
  completionTokens: 5,
  durationMs: 100,
  createdAt: "2026-10-17T10:00:00.000Z",
  ...overrides
});

describe("SqliteApiUsageStore", () => {
  it("adds up calls, errors and tokens per key since a date", async () => {
    const { usage } = await setup();
    await usage.record(call({}));
    await usage.record(call({ status: 404, promptTokens: 0, completionTokens: 0 }));
    await usage.record(call({ createdAt: "2026-09-01T10:00:00.000Z" }));
    await usage.record(call({ keyId: "key_b", completionTokens: 7 }));
    const totals = await usage.totalsByKey(["key_a", "key_b"], "2026-10-01T00:00:00.000Z");
    expect(totals.get("key_a")).toEqual({ calls: 2, errors: 1, promptTokens: 10, completionTokens: 5 });
    expect(totals.get("key_b")).toEqual({ calls: 1, errors: 0, promptTokens: 10, completionTokens: 7 });
    expect(await usage.totalsByKey([], "2026-10-01T00:00:00.000Z")).toEqual(new Map());
  });

  it("groups days on the viewer's clock, not UTC", async () => {
    const { usage } = await setup();
    // 23:30 UTC on the 16th is already 01:30 on the 17th in Italy (UTC+2).
    await usage.record(call({ createdAt: "2026-10-16T23:30:00.000Z" }));
    await usage.record(call({ createdAt: "2026-10-17T08:00:00.000Z" }));
    expect((await usage.daily("key_a", "2026-10-01T00:00:00.000Z", 0)).map((day) => [day.day, day.calls])).toEqual([
      ["2026-10-16", 1],
      ["2026-10-17", 1]
    ]);
    expect((await usage.daily("key_a", "2026-10-01T00:00:00.000Z", 120)).map((day) => [day.day, day.calls])).toEqual([["2026-10-17", 2]]);
  });

  it("splits by model and lists the latest calls first", async () => {
    const { usage } = await setup();
    await usage.record(call({ createdAt: "2026-10-17T08:00:00.000Z" }));
    await usage.record(call({ model: "embeddinggemma:latest", endpoint: "embeddings", createdAt: "2026-10-17T09:00:00.000Z" }));
    await usage.record(call({ createdAt: "2026-10-17T09:30:00.000Z", streamed: true }));
    expect((await usage.byModel("key_a", "2026-10-01T00:00:00.000Z")).map((row) => [row.model, row.calls])).toEqual([
      ["gemma3:270m", 2],
      ["embeddinggemma:latest", 1]
    ]);
    const recent = await usage.recent("key_a", 2);
    expect(recent.map((entry) => entry.createdAt)).toEqual(["2026-10-17T09:30:00.000Z", "2026-10-17T09:00:00.000Z"]);
    expect(recent[0]).toMatchObject({ streamed: true, endpoint: "chat" });
  });

  it("forgets old calls and follows a deleted key", async () => {
    const { db, usage } = await setup();
    await usage.record(call({ createdAt: "2025-01-01T00:00:00.000Z" }));
    await usage.record(call({}));
    await usage.deleteOlderThan("2025-10-17T00:00:00.000Z");
    expect(await usage.recent("key_a", 10)).toHaveLength(1);
    db.prepare("DELETE FROM api_keys WHERE id = 'key_a'").run();
    expect(await usage.recent("key_a", 10)).toEqual([]);
  });
});
