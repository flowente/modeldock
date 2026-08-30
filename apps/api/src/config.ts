import { existsSync } from "node:fs";
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
    ollamaBaseUrl: env.MODELDOCK_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaMode: parseOllamaMode(env.MODELDOCK_OLLAMA_MODE),
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

export function loadLocalEnvFile(startDirectory = process.cwd()): void {
  let currentDirectory = startDirectory;

  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(currentDirectory, ".env");

    if (existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return;
    }

    currentDirectory = parentDirectory;
  }
}
