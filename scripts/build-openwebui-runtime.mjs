import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
const runtimeVersion = process.argv[3] ?? "1";
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

run(
  bundlePython,
  ["-c", "import open_webui; print('Open WebUI runtime import succeeded')"],
  {
    ...process.env,
    PYTHONPATH: sitePackagesDir
  }
);

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
