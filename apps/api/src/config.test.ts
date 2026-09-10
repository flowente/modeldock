import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig, mergeStrayEnvFile, parseOllamaMode, parseTailscaleMode, resolveLocalEnvPath, resolveProjectRoot } from "./config.ts";

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

describe("local environment file", () => {
  it("anchors the env file to the workspace root, not the working directory", () => {
    // The API is launched from apps/api; the root is where pnpm-workspace.yaml is.
    expect(existsSync(join(resolveProjectRoot(), "pnpm-workspace.yaml"))).toBe(true);
    expect(resolveLocalEnvPath()).toBe(join(resolveProjectRoot(), ".env"));
    expect(loadServerConfig({}).localEnvPath).toBe(resolveLocalEnvPath());
  });

  it("folds a stray env file into the root one without losing existing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "modeldock-env-"));

    try {
      const rootPath = join(directory, ".env");
      const strayDirectory = join(directory, "apps", "api");
      mkdirSync(strayDirectory, { recursive: true });
      const strayPath = join(strayDirectory, ".env");

      writeFileSync(rootPath, ["MODELDOCK_TAILSCALE_API_TOKEN=root-token", "MODELDOCK_OPENWEBUI_BASE_URL=", ""].join("\n"), "utf8");
      writeFileSync(
        strayPath,
        ["MODELDOCK_OPENWEBUI_API_KEY=stray-key", "MODELDOCK_OPENWEBUI_BASE_URL=http://127.0.0.1:8080", "MODELDOCK_TAILSCALE_API_TOKEN=stray-token", ""].join("\n"),
        "utf8"
      );

      expect(mergeStrayEnvFile(strayPath, rootPath)).toBe(true);

      const merged = readFileSync(rootPath, "utf8");
      expect(merged).toContain("MODELDOCK_OPENWEBUI_API_KEY=stray-key");
      // A value already set at the root wins over the stray copy.
      expect(merged).toContain("MODELDOCK_TAILSCALE_API_TOKEN=root-token");
      expect(merged).not.toContain("stray-token");
      // An empty key at the root is filled in place, not duplicated.
      expect(merged).toContain("MODELDOCK_OPENWEBUI_BASE_URL=http://127.0.0.1:8080");
      expect(merged.split(/\r?\n/).filter((line) => line.startsWith("MODELDOCK_OPENWEBUI_BASE_URL="))).toHaveLength(1);
      // The old file is kept, never deleted.
      expect(existsSync(strayPath)).toBe(false);
      expect(existsSync(`${strayPath}.migrated`)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does nothing when there is no stray file", () => {
    const directory = mkdtempSync(join(tmpdir(), "modeldock-env-"));

    try {
      expect(mergeStrayEnvFile(join(directory, "missing", ".env"), join(directory, ".env"))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
