import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runtimeVersion = process.argv[2];
const releaseTag = process.argv[3];
const assetsDirectory = resolve(process.argv[4] ?? ".");
const repository = process.env.GITHUB_REPOSITORY ?? "flowente/modeldock";

if (!runtimeVersion || !releaseTag) {
  throw new Error("Usage: create-openwebui-runtime-manifest <version> <release-tag> <assets-directory>");
}

const targets = {
  "windows-x64": {
    pythonPath: "python/python.exe",
    sitePackagesPath: "site-packages"
  },
  "macos-arm64": {
    pythonPath: "python/bin/python3.11",
    sitePackagesPath: "site-packages"
  },
  "macos-x64": {
    pythonPath: "python/bin/python3.11",
    sitePackagesPath: "site-packages"
  }
};

const manifestTargets = Object.fromEntries(
  await Promise.all(
    Object.entries(targets).map(async ([target, paths]) => {
      const assetName = `modeldock-openwebui-${target}.tar.gz`;
      const assetPath = join(assetsDirectory, assetName);

      return [
        target,
        {
          archiveUrl: `https://github.com/${repository}/releases/download/${releaseTag}/${assetName}`,
          ...paths,
          sha256: await hashFile(assetPath),
          sizeBytes: statSync(assetPath).size
        }
      ];
    })
  )
);

writeFileSync(
  join(assetsDirectory, "manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      version: runtimeVersion,
      targets: manifestTargets
    },
    null,
    2
  )
);

async function hashFile(path) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}
