import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "./index.js";

describe("InMemoryAuditStore", () => {
  it("stores newest audit events first", async () => {
    const store = new InMemoryAuditStore(
      { now: () => new Date("2026-08-29T00:00:00.000Z") },
      { createId: (prefix) => `${prefix}_1` }
    );

    await store.append({
      actorId: "system",
      action: "FIRST",
      module: "test",
      result: "success",
      correlationId: "req_1"
    });

    const events = await store.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("FIRST");
  });
});

