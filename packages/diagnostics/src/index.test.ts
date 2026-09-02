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
        probeModel: async () => ({ model: "llama3.1:8b", output: "ok", durationMs: 1 })
      },
      tailscale: {
        getLocalStatus: async () => ({
          name: "tailscale",
          status: "available",
          message: "Tailscale fake is reachable",
          checkedAt: "2026-08-29T00:00:00.000Z"
        }),
        listDevices: async () => [],
        createUserInvite: async () => ({
          id: "invite_1",
          inviteUrl: "https://login.tailscale.com/uinv/test",
          role: "member"
        }),
        updateDeviceAuthorization: async () => ({
          id: "device_1",
          hostname: "test-device",
          addresses: [],
          online: "unknown",
          authorized: true
        })
      }
    });

    const results = await registry.runAll();

    expect(results.map((result) => result.id)).toContain("backend.health");
    expect(results.map((result) => result.id)).toContain("ollama.connection");
    expect(results.every((result) => result.timestamp === "2026-08-29T00:00:00.000Z")).toBe(true);
  });
});
