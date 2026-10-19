import { describe, expect, it } from "vitest";
import { createDiagnosticRegistry } from "./index.js";

describe("diagnostics", () => {
  it("runs all registered checks", async () => {
    const registry = createDiagnosticRegistry({
      clock: { now: () => new Date("2026-08-29T00:00:00.000Z") },
      auditStore: {
        append: async (input) => ({
          id: "audit_1",
          timestamp: "2026-08-29T00:00:00.000Z",
          ...input
        }),
        list: async () => []
      },
      ollama: {
        getHealth: async () => ({
          name: "ollama",
          status: "available",
          message: "Ollama fake is reachable",
          checkedAt: "2026-08-29T00:00:00.000Z"
        }),
        listLocalModels: async () => [],
        listRunningModels: async () => [],
        loadModel: async () => {},
        unloadModel: async () => {},
        pullModel: async function* () {},
        deleteModel: async () => {},
        probeModel: async () => ({ model: "llama3.1:8b", output: "ok", durationMs: 1 }),
        chat: async function* () {},
        getModelCapabilities: async () => ["completion"],
        warmModel: async () => ({ loadMs: 0 }),
        openAi: async () => ({ status: 200, contentType: "application/json", body: (async function* () {})() })
      }
    });

    const results = await registry.runAll();

    expect(results.map((result) => result.id)).toContain("backend.health");
    expect(results.map((result) => result.id)).toContain("ollama.connection");
    expect(results.every((result) => result.timestamp === "2026-08-29T00:00:00.000Z")).toBe(true);
  });
});
