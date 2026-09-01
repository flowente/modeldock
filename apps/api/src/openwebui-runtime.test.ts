import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareOpenWebUIRuntimeBundle,
  resolveOpenWebUIRuntimeBaseDir,
  resolveOpenWebUIRuntimeTarget
} from "./openwebui-runtime.ts";

describe("prepared Open WebUI runtime", () => {
  it("selects a release asset only for supported targets", () => {
    expect(resolveOpenWebUIRuntimeTarget("win32", "x64")).toBe("windows-x64");
    expect(resolveOpenWebUIRuntimeTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(resolveOpenWebUIRuntimeTarget("darwin", "x64")).toBe("macos-x64");
    expect(resolveOpenWebUIRuntimeTarget("linux", "x64")).toBeUndefined();
  });

  it("keeps prepared runtimes outside the application checkout", () => {
    expect(resolveOpenWebUIRuntimeBaseDir("win32", "C:\\Users\\Simone")).toBe(
      "C:\\Users\\Simone\\AppData\\Local\\ModelDock\\runtime\\open-webui"
    );
    expect(resolveOpenWebUIRuntimeBaseDir("darwin", "/Users/simone")).toBe(
      "/Users/simone/.modeldock/runtime/open-webui"
    );
  });

  it("reuses a verified prepared runtime without downloading its archive again", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "modeldock-runtime-test-"));
    const runtimeDir = join(baseDir, "1", "macos-x64");
    const pythonPath = join(runtimeDir, "python", "bin", "python3.11");
    const sitePackagesPath = join(runtimeDir, "site-packages");
    const sha256 = "a".repeat(64);
    await mkdir(join(runtimeDir, "python", "bin"), { recursive: true });
    await mkdir(sitePackagesPath, { recursive: true });
    await writeFile(pythonPath, "", "utf8");
    await writeFile(join(runtimeDir, ".ready.json"), JSON.stringify({ sha256 }), "utf8");
    const requestedUrls: string[] = [];

    try {
      const prepared = await prepareOpenWebUIRuntimeBundle({
        architecture: "x64",
        baseDir,
        fetchImpl: async (url) => {
          requestedUrls.push(String(url));
          return Response.json({
            schemaVersion: 1,
            version: "1",
            targets: {
              "macos-x64": {
                archiveUrl: "https://example.invalid/modeldock-openwebui-macos-x64.tar.gz",
                pythonPath: "python/bin/python3.11",
                sha256,
                sitePackagesPath: "site-packages",
                sizeBytes: 123
              }
            }
          });
        },
        manifestUrl: "https://example.invalid/manifest.json",
        platformId: "darwin"
      });

      expect(prepared).toEqual({ pythonPath, sitePackagesPath, target: "macos-x64", version: "1" });
      expect(requestedUrls).toEqual(["https://example.invalid/manifest.json"]);
    } finally {
      await rm(baseDir, { force: true, recursive: true });
    }
  });
});
