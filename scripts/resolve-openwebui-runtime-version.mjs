import { appendFileSync } from "node:fs";

const requestedVersion = process.env.INPUT_RUNTIME_VERSION?.trim();
const tagVersion = process.env.GITHUB_REF_NAME?.replace(/^openwebui-runtime-v/, "").trim();
const version = requestedVersion || tagVersion;

if (!version || !/^[a-zA-Z0-9._-]+$/.test(version)) {
  throw new Error(`Invalid Open WebUI runtime version: ${version ?? "missing"}`);
}

const outputPath = process.env.GITHUB_OUTPUT;

if (!outputPath) {
  process.stdout.write(`${version}\n`);
} else {
  appendFileSync(outputPath, `version=${version}\n`);
}
