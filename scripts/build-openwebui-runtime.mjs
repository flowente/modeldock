import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const target = process.argv[2];
const runtimeVersion = process.argv[3] ?? "6";
const supportedTargets = new Set(["windows-x64", "macos-arm64", "macos-x64"]);

if (!target || !supportedTargets.has(target)) {
  throw new Error(`Unsupported runtime target: ${target ?? "missing"}`);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const targetRoot = join(repositoryRoot, ".runtime-build", target);
const managedPythonDir = join(targetRoot, "managed-python");
const bundleDir = join(targetRoot, "bundle");
const bundlePythonDir = join(bundleDir, "python");
const sitePackagesDir = join(bundleDir, "site-packages");
const isWindows = target === "windows-x64";
const openWebUIVersion = target === "macos-x64" ? "0.7.2" : "0.11.1";
const extraPackages = ["greenlet", "itsdangerous", "beautifulsoup4"];

if (target === "windows-x64") {
  extraPackages.push("pywin32");
}

if (target === "macos-x64") {
  extraPackages.push("cryptography==48.0.1");
}

rmSync(targetRoot, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const uvEnvironment = {
  ...process.env,
  UV_PYTHON_INSTALL_DIR: managedPythonDir
};

run("uv", ["python", "install", "3.11", "--install-dir", managedPythonDir], uvEnvironment);
const managedPython = run("uv", ["python", "find", "3.11"], uvEnvironment).trim().split(/\r?\n/).at(-1);

if (!managedPython || !existsSync(managedPython)) {
  throw new Error("uv did not return a usable managed Python executable.");
}

const managedPythonRoot = isWindows ? dirname(managedPython) : dirname(dirname(managedPython));
cpSync(managedPythonRoot, bundlePythonDir, { recursive: true });
const bundlePython = isWindows ? join(bundlePythonDir, "python.exe") : join(bundlePythonDir, "bin", "python3.11");

if (!existsSync(bundlePython)) {
  throw new Error(`Bundled Python executable was not found at ${bundlePython}.`);
}

mkdirSync(sitePackagesDir, { recursive: true });
run(
  "uv",
  [
    "pip",
    "install",
    "--python",
    bundlePython,
    "--target",
    sitePackagesDir,
    `open-webui==${openWebUIVersion}`,
    ...extraPackages
  ],
  uvEnvironment
);

const runtimePythonPath = resolveRuntimePythonPath(sitePackagesDir, isWindows);
run(
  bundlePython,
  [
    "-c",
    isWindows
      ? "import open_webui, pywintypes, win32api; print('Open WebUI Windows runtime imports succeeded')"
      : "import open_webui; print('Open WebUI runtime import succeeded')"
  ],
  {
    ...process.env,
    PYTHONPATH: runtimePythonPath
  }
);
try {
  await verifyServerStartup(bundlePython, runtimePythonPath, targetRoot);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`::error title=Open WebUI HTTP smoke test failed::${escapeWorkflowCommand(message)}\n`);
  throw error;
}

writeFileSync(
  join(bundleDir, "runtime.json"),
  JSON.stringify(
    {
      runtimeVersion,
      target,
      openWebUIVersion,
      pythonVersion: "3.11"
    },
    null,
    2
  )
);

const assetPath = join(targetRoot, `modeldock-openwebui-${target}.tar.gz`);
run("tar", ["-czf", assetPath, "-C", bundleDir, "."], process.env);
process.stdout.write(`${assetPath}\n`);

function run(command, args, env) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"]
  });
}

async function verifyServerStartup(pythonPath, runtimePythonPath, buildRoot) {
  const smokeDataDir = join(buildRoot, "smoke-data");
  const port = 18080;
  const child = spawn(
    pythonPath,
    ["-c", "from open_webui import app; app()", "serve", "--host", "127.0.0.1", "--port", String(port)],
    {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATA_DIR: smokeDataDir,
      ENABLE_API_KEYS: "true",
      ENABLE_SIGNUP: "false",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      PORT: String(port),
      PYTHONPATH: runtimePythonPath,
      WEBUI_SECRET_KEY: "modeldock-runtime-build-smoke-test"
    },
    stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const logLines = [];
  const capture = (chunk) => {
    logLines.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    logLines.splice(0, Math.max(logLines.length - 30, 0));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  try {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`Open WebUI smoke server exited with code ${child.exitCode}.\n${logLines.join("\n")}`);
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });

        if (response.status < 500) {
          process.stdout.write(`Open WebUI HTTP smoke test succeeded with status ${response.status}.\n`);
          return;
        }
      } catch {
        // The server is still running its first database migration or loading modules.
      }

      await delay(2_000);
    }

    throw new Error(`Open WebUI did not answer within the smoke-test timeout.\n${logLines.join("\n")}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), delay(10_000)]);
    }

    rmSync(smokeDataDir, { force: true, recursive: true });
  }
}

function resolveRuntimePythonPath(sitePackagesPath, includeWindowsExtensions) {
  const paths = [sitePackagesPath];

  if (includeWindowsExtensions) {
    paths.push(
      join(sitePackagesPath, "win32"),
      join(sitePackagesPath, "win32", "lib"),
      join(sitePackagesPath, "Pythonwin"),
      join(sitePackagesPath, "pywin32_system32")
    );
  }

  return paths.join(process.platform === "win32" ? ";" : ":");
}

function escapeWorkflowCommand(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
