import { describe, expect, it } from "vitest";
import { loadServerConfig, parseOllamaMode, parseTailscaleMode } from "./config.ts";

describe("server configuration", () => {
  it("uses safe local defaults", () => {
    expect(loadServerConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 4317,
      logger: true,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaMode: "auto",
      tailscaleMode: "auto"
    });
  });

  it("accepts supported adapter modes", () => {
    expect(parseOllamaMode("fake")).toBe("fake");
    expect(parseOllamaMode("real")).toBe("real");
    expect(parseOllamaMode("surprise")).toBe("auto");
    expect(parseTailscaleMode("api")).toBe("api");
    expect(parseTailscaleMode("cli")).toBe("cli");
    expect(parseTailscaleMode("surprise")).toBe("auto");
  });
});
