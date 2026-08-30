import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { buildApp, type OllamaRuntimeMode, type TailscaleRuntimeMode } from "./app.ts";

loadLocalEnvFile();

const host = process.env.MODELDOCK_API_HOST ?? "127.0.0.1";
const port = Number(process.env.MODELDOCK_API_PORT ?? "4317");
const ollamaMode = parseOllamaMode(process.env.MODELDOCK_OLLAMA_MODE);
const ollamaBaseUrl = process.env.MODELDOCK_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const openWebUIBaseUrl = process.env.MODELDOCK_OPENWEBUI_BASE_URL;
const tailscaleApiBaseUrl = process.env.MODELDOCK_TAILSCALE_API_BASE_URL;
const tailscaleApiToken = process.env.MODELDOCK_TAILSCALE_API_TOKEN;
const tailscaleMode = parseTailscaleMode(process.env.MODELDOCK_TAILSCALE_MODE);
const tailscaleTailnet = process.env.MODELDOCK_TAILSCALE_TAILNET;

const app = await buildApp({
  logger: true,
  ollamaBaseUrl,
  ollamaMode,
  openWebUIBaseUrl,
  tailscaleApiBaseUrl,
  tailscaleApiToken,
  tailscaleMode,
  tailscaleTailnet
});

await app.listen({ host, port });

function parseOllamaMode(value: string | undefined): OllamaRuntimeMode {
  if (value === "fake" || value === "real" || value === "auto") {
    return value;
  }

  return "auto";
}

function parseTailscaleMode(value: string | undefined): TailscaleRuntimeMode {
  if (value === "fake" || value === "real" || value === "cli" || value === "api" || value === "auto") {
    return value;
  }

  return "auto";
}

function loadLocalEnvFile(): void {
  let currentDirectory = process.cwd();

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
