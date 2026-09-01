import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_RUNTIME_VERSION = "2";
const DEFAULT_MANIFEST_URL =
  "https://github.com/flowente/modeldock/releases/download/openwebui-runtime-v2/manifest.json";

export type OpenWebUIRuntimeTarget = "windows-x64" | "macos-arm64" | "macos-x64";

export interface OpenWebUIRuntimeAsset {
  archiveUrl: string;
  pythonPath: string;
  sha256: string;
  sitePackagesPath: string;
  sizeBytes: number;
}

export interface OpenWebUIRuntimeManifest {
  schemaVersion: 1;
  version: string;
  targets: Partial<Record<OpenWebUIRuntimeTarget, OpenWebUIRuntimeAsset>>;
}

export interface PreparedOpenWebUIRuntime {
  pythonPath: string;
  sitePackagesPath: string;
  target: OpenWebUIRuntimeTarget;
  version: string;
}

export interface RuntimePreparationProgress {
  message: string;
  percent?: number;
}

export function resolveOpenWebUIRuntimeTarget(
  platformId: NodeJS.Platform = platform(),
  architecture: NodeJS.Architecture = arch()
): OpenWebUIRuntimeTarget | undefined {
  if (platformId === "win32" && architecture === "x64") {
    return "windows-x64";
  }

  if (platformId === "darwin" && architecture === "arm64") {
    return "macos-arm64";
  }

  if (platformId === "darwin" && architecture === "x64") {
    return "macos-x64";
  }

  return undefined;
}

export function resolveOpenWebUIRuntimeBaseDir(
  platformId: NodeJS.Platform = platform(),
  homeDirectory: string = homedir()
): string {
  return platformId === "win32"
    ? win32.join(homeDirectory, "AppData", "Local", "ModelDock", "runtime", "open-webui")
    : posix.join(homeDirectory, ".modeldock", "runtime", "open-webui");
}

export async function prepareOpenWebUIRuntimeBundle(input: {
  baseDir?: string;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
  onProgress?: (progress: RuntimePreparationProgress) => void;
  platformId?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
} = {}): Promise<PreparedOpenWebUIRuntime | undefined> {
  const platformId = input.platformId ?? platform();
  const architecture = input.architecture ?? arch();
  const target = resolveOpenWebUIRuntimeTarget(platformId, architecture);

  if (!target) {
    return undefined;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const manifestUrl = input.manifestUrl?.trim() || process.env.MODELDOCK_OPENWEBUI_RUNTIME_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL;
  input.onProgress?.({ message: "Checking the prepared chat runtime." });
  const manifestResponse = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15_000) });

  if (!manifestResponse.ok) {
    throw new Error(`Prepared runtime manifest responded with HTTP ${manifestResponse.status}.`);
  }

  const manifest = validateRuntimeManifest((await manifestResponse.json()) as unknown);
  const asset = manifest.targets[target];

  if (!asset) {
    return undefined;
  }

  const baseDir = input.baseDir ?? resolveOpenWebUIRuntimeBaseDir(platformId);
  const runtimeDir = join(baseDir, sanitizePathSegment(manifest.version), target);
  const pythonPath = join(runtimeDir, asset.pythonPath);
  const sitePackagesPath = join(runtimeDir, asset.sitePackagesPath);
  const readyPath = join(runtimeDir, ".ready.json");

  if (existsSync(pythonPath) && existsSync(sitePackagesPath) && existsSync(readyPath)) {
    try {
      const ready = JSON.parse(await readFile(readyPath, "utf8")) as { sha256?: string };

      if (ready.sha256 === asset.sha256.toLowerCase()) {
        input.onProgress?.({ message: "The prepared chat runtime is ready.", percent: 100 });
        return { pythonPath, sitePackagesPath, target, version: manifest.version };
      }
    } catch {
      // A partial marker is treated as an incomplete runtime and replaced below.
    }
  }

  const temporaryDir = await mkdtemp(join(tmpdir(), "modeldock-openwebui-"));
  const archivePath = join(temporaryDir, basename(new URL(asset.archiveUrl).pathname) || `${target}.tar.gz`);

  try {
    input.onProgress?.({ message: "Downloading the prepared chat runtime.", percent: 0 });
    const actualSha256 = await downloadRuntimeAsset(asset.archiveUrl, archivePath, asset.sizeBytes, fetchImpl, input.onProgress);

    if (actualSha256 !== asset.sha256.toLowerCase()) {
      throw new Error("Prepared runtime checksum verification failed.");
    }

    input.onProgress?.({ message: "Installing the prepared chat runtime.", percent: 96 });
    await rm(runtimeDir, { force: true, recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await extractTarArchive(archivePath, runtimeDir);

    if (!existsSync(pythonPath) || !existsSync(sitePackagesPath)) {
      throw new Error("Prepared runtime archive is incomplete.");
    }

    if (platformId !== "win32") {
      await chmod(pythonPath, 0o755);
    }

    await writeFile(
      readyPath,
      JSON.stringify({ schemaVersion: 1, sha256: asset.sha256.toLowerCase(), version: manifest.version }, null, 2),
      "utf8"
    );
    input.onProgress?.({ message: "The prepared chat runtime is ready.", percent: 100 });

    return { pythonPath, sitePackagesPath, target, version: manifest.version };
  } catch (error) {
    await rm(runtimeDir, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(temporaryDir, { force: true, recursive: true });
  }
}

function validateRuntimeManifest(value: unknown): OpenWebUIRuntimeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Prepared runtime manifest is invalid.");
  }

  const candidate = value as Partial<OpenWebUIRuntimeManifest>;

  if (candidate.schemaVersion !== 1 || typeof candidate.version !== "string" || !candidate.targets || typeof candidate.targets !== "object") {
    throw new Error("Prepared runtime manifest is invalid.");
  }

  for (const asset of Object.values(candidate.targets)) {
    if (
      !asset ||
      typeof asset.archiveUrl !== "string" ||
      !isHttpsUrl(asset.archiveUrl) ||
      typeof asset.pythonPath !== "string" ||
      !isSafeRelativePath(asset.pythonPath) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
      typeof asset.sitePackagesPath !== "string" ||
      !isSafeRelativePath(asset.sitePackagesPath) ||
      typeof asset.sizeBytes !== "number" ||
      !Number.isFinite(asset.sizeBytes) ||
      asset.sizeBytes <= 0
    ) {
      throw new Error("Prepared runtime manifest contains an invalid asset.");
    }
  }

  return candidate as OpenWebUIRuntimeManifest;
}

async function downloadRuntimeAsset(
  url: string,
  destination: string,
  expectedSize: number,
  fetchImpl: typeof fetch,
  onProgress?: (progress: RuntimePreparationProgress) => void
): Promise<string> {
  const response = await fetchImpl(url);

  if (!response.ok || !response.body) {
    throw new Error(`Prepared runtime download responded with HTTP ${response.status}.`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const file = await open(destination, "w");
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  const totalBytes = Number(response.headers.get("content-length")) || expectedSize;
  let receivedBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      hash.update(chunk.value);
      let offset = 0;

      while (offset < chunk.value.byteLength) {
        const result = await file.write(chunk.value, offset);
        offset += result.bytesWritten;
      }
      receivedBytes += chunk.value.byteLength;

      if (totalBytes > 0) {
        onProgress?.({
          message: `Downloading the prepared chat runtime (${Math.min(Math.round((receivedBytes / totalBytes) * 100), 100)}%).`,
          percent: Math.min((receivedBytes / totalBytes) * 95, 95)
        });
      }
    }
  } finally {
    await file.close();
  }

  return hash.digest("hex");
}

async function extractTarArchive(archivePath: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(errorOutput.trim() || `Runtime extraction exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function sanitizePathSegment(value: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(value) ? value : DEFAULT_RUNTIME_VERSION;
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");

  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
