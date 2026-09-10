import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import type { BuildAppOptions, OllamaRuntimeMode, TailscaleRuntimeMode } from "./app.ts";

export interface ServerConfig extends BuildAppOptions {
  host: string;
  port: number;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MODELDOCK_API_HOST ?? "127.0.0.1",
    port: Number(env.MODELDOCK_API_PORT ?? "4317"),
    logger: true,
    // Anchored to the workspace root so setup writes the same file it reads.
    localEnvPath: resolveLocalEnvPath(),
    ollamaBaseUrl: env.MODELDOCK_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaModelsPath: env.MODELDOCK_OLLAMA_MODELS_PATH,
    ollamaMode: parseOllamaMode(env.MODELDOCK_OLLAMA_MODE),
    openWebUIApiKey: env.MODELDOCK_OPENWEBUI_API_KEY,
    openWebUIBaseUrl: env.MODELDOCK_OPENWEBUI_BASE_URL,
    tailscaleApiBaseUrl: env.MODELDOCK_TAILSCALE_API_BASE_URL,
    tailscaleApiToken: env.MODELDOCK_TAILSCALE_API_TOKEN,
    tailscaleMode: parseTailscaleMode(env.MODELDOCK_TAILSCALE_MODE),
    tailscaleTailnet: env.MODELDOCK_TAILSCALE_TAILNET
  };
}

export function parseOllamaMode(value: string | undefined): OllamaRuntimeMode {
  if (value === "fake" || value === "real" || value === "auto") {
    return value;
  }

  return "auto";
}

export function parseTailscaleMode(value: string | undefined): TailscaleRuntimeMode {
  if (value === "fake" || value === "real" || value === "cli" || value === "api" || value === "auto") {
    return value;
  }

  return "auto";
}

/**
 * Locates the workspace root from this file, not from the current directory.
 *
 * pnpm launches the API with `apps/api` as the working directory, so anything
 * anchored to `process.cwd()` reads one config file and writes another: setup
 * saved its keys into `apps/api/.env`, which then shadowed the real `.env` at
 * the root and silently dropped every other setting, the Tailscale token
 * included.
 */
export function resolveProjectRoot(startDirectory = import.meta.dirname): string {
  let currentDirectory = startDirectory;

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(currentDirectory, "pnpm-workspace.yaml"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return process.cwd();
}

export function resolveLocalEnvPath(): string {
  return join(resolveProjectRoot(), ".env");
}

export function readEnvKeysWithValues(content: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);

    if (match && match[2]!.trim().length > 0) {
      entries.set(match[1]!, line);
    }
  }

  return entries;
}

/**
 * Folds a stray `.env` left inside an app folder back into the root one.
 *
 * Installs made before the fix already have keys in the wrong place, and
 * reading only the root file would silently lose them. Values already set at
 * the root win, and the stray file is renamed rather than deleted so nothing
 * disappears without the user being able to see it.
 */
export function mergeStrayEnvFile(strayPath: string, rootPath: string): boolean {
  if (strayPath === rootPath || !existsSync(strayPath)) {
    return false;
  }

  const rootContent = existsSync(rootPath) ? readFileSync(rootPath, "utf8") : "";
  const rootEntries = readEnvKeysWithValues(rootContent);
  const pending = new Map(
    [...readEnvKeysWithValues(readFileSync(strayPath, "utf8"))].filter(([key]) => !rootEntries.has(key))
  );

  if (pending.size > 0) {
    // A key declared empty at the root gets filled in place, so the file never
    // ends up with the same key twice.
    const lines = rootContent.split(/\r?\n/).map((line) => {
      const key = line.match(/^\s*([A-Z0-9_]+)=\s*$/)?.[1];
      const replacement = key ? pending.get(key) : undefined;

      if (key && replacement) {
        pending.delete(key);
        return replacement;
      }

      return line;
    });

    while (lines.length > 0 && lines.at(-1)!.trim().length === 0) {
      lines.pop();
    }

    writeFileSync(rootPath, `${[...lines, ...pending.values()].join("\n")}\n`, "utf8");
  }

  renameSync(strayPath, `${strayPath}.migrated`);
  return true;
}

export function loadLocalEnvFile(startDirectory = process.cwd()): void {
  const rootPath = resolveLocalEnvPath();

  if (mergeStrayEnvFile(join(startDirectory, ".env"), rootPath)) {
    console.warn(`ModelDock moved settings from ${join(startDirectory, ".env")} into ${rootPath}, and kept the old file as .env.migrated.`);
  }

  if (existsSync(rootPath)) {
    loadEnvFile(rootPath);
  }
}
