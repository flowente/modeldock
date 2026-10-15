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
      link: component("link", "available"),
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
      link: component("link", "available"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("fail");
    expect(status.warnings).toContain("ollama: ollama unavailable");
  });

  it("a device connection switched off on purpose does not make the server unhealthy", () => {
    const status = buildSystemStatus({
      backend: component("backend", "available"),
      storage: component("storage", "available"),
      ollama: component("ollama", "available"),
      link: component("link", "not_configured"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("ok");
  });

  it("a device connection that should run but does not is reported", () => {
    const status = buildSystemStatus({
      backend: component("backend", "available"),
      storage: component("storage", "available"),
      ollama: component("ollama", "available"),
      link: component("link", "unavailable"),
      checkedAt: "2026-08-29T00:00:00.000Z"
    });

    expect(status.overall).toBe("fail");
    expect(status.warnings).toContain("link: link unavailable");
  });
});
