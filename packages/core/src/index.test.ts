import { describe, expect, it } from "vitest";
import { buildSystemStatus, type ComponentHealth } from "./index.js";

const component = (name: string, status: ComponentHealth["status"]): ComponentHealth => ({
  name,
  status,
  message: `${name} ${status}`,
  checkedAt: "2026-08-29T00:00:00.000Z"
});

describe("system health", () => {
  it("marks the system ok when every component is available", () => {
    const status = buildSystemStatus({
      backend: component("backend", "available"),
      storage: component("storage", "available"),
      ollama: component("ollama", "available"),
      tailscale: component("tailscale", "available"),
      openWebUI: component("open-webui", "not_configured"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("ok");
    expect(status.warnings).toEqual([]);
  });

  it("marks the system failed when a dependency is unavailable", () => {
    const status = buildSystemStatus({
      backend: component("backend", "available"),
      storage: component("storage", "available"),
      ollama: component("ollama", "unavailable"),
      tailscale: component("tailscale", "available"),
      openWebUI: component("open-webui", "not_configured"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("fail");
    expect(status.warnings).toContain("ollama: ollama unavailable");
  });

  it("includes configured Open WebUI in aggregate health", () => {
    const status = buildSystemStatus({
      backend: component("backend", "available"),
      storage: component("storage", "available"),
      ollama: component("ollama", "available"),
      tailscale: component("tailscale", "available"),
      openWebUI: component("open-webui", "unavailable"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("fail");
    expect(status.warnings).toContain("open-webui: open-webui unavailable");
  });
});
