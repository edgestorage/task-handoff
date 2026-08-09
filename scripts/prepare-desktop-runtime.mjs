#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const controlledInstancePackage = JSON.parse(fs.readFileSync(path.join(root, "packages", "controlled-instance", "package.json"), "utf8"));
const nodePtyPackage = JSON.parse(fs.readFileSync(require.resolve("node-pty/package.json"), "utf8"));
const version = process.env.TASK_HANDOFF_VERSION || controlledInstancePackage.version;
const prebuildsDir = path.join(root, "release", "node-pty-prebuilds");
const prebuildVersionFile = path.join(root, "release", "node-pty-prebuilds.version");
const artifactsDir = path.join(root, "release", "runtime-artifacts");
const stem = `controlled-instance-runtime-${version}-linux-universal`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status || 1);
}

function artifactFiles() {
  return [
    path.join(artifactsDir, `${stem}.tar.gz`),
    path.join(artifactsDir, `${stem}.manifest.json`),
    path.join(artifactsDir, `${stem}.tar.gz.sha256`),
  ];
}

function verifyArtifact() {
  const [archive, manifest, checksum] = artifactFiles();
  for (const file of [archive, manifest, checksum]) {
    if (!fs.existsSync(file)) throw new Error(`Desktop runtime artifact is missing: ${path.relative(root, file)}`);
  }
  const identity = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (identity.version !== version || identity.platform !== "linux" || identity.arch !== "universal") {
    throw new Error(`Desktop runtime artifact must be controlled-instance ${version}-linux-universal.`);
  }
  run(process.execPath, ["scripts/runtime-artifact.mjs", "verify", "--archive", archive, "--sha256", checksum, "--version", version, "--platform", "linux", "--arch", "universal"]);
}

function hasLinuxPrebuild(arch) {
  return fs.existsSync(path.join(prebuildsDir, `linux-${arch}`, "pty.node"));
}

function buildLinuxPrebuild(arch) {
  if (hasLinuxPrebuild(arch)) return;
  const dockerArch = arch === "x64" ? "amd64" : "arm64";
  const script = [
    "set -euo pipefail",
    "rm -rf /tmp/node-pty",
    "mkdir -p /tmp/node-pty",
    "cp -R -L /workspace/node_modules/node-pty/. /tmp/node-pty/",
    "rm -rf /tmp/node-pty/build",
    "cd /tmp/node-pty",
    "NODE_PATH=/workspace/node_modules npm_config_nodedir=/usr/local node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild",
    `node /workspace/scripts/node-pty-prebuild.mjs build --package-dir /tmp/node-pty --output /workspace/release/node-pty-prebuilds --platform linux --arch ${arch}`,
  ].join("; ");
  run("docker", [
    "run", "--rm", "--platform", `linux/${dockerArch}`,
    "-v", `${root}:/workspace`, "-w", "/workspace",
    "node:24-bullseye", "bash", "-lc", script,
  ]);
}

function prepareArtifact() {
  const cachedNodePtyVersion = fs.existsSync(prebuildVersionFile) ? fs.readFileSync(prebuildVersionFile, "utf8").trim() : "";
  if (cachedNodePtyVersion !== nodePtyPackage.version) {
    fs.rmSync(prebuildsDir, { recursive: true, force: true });
  }
  buildLinuxPrebuild("x64");
  buildLinuxPrebuild("arm64");
  fs.mkdirSync(path.dirname(prebuildVersionFile), { recursive: true });
  fs.writeFileSync(prebuildVersionFile, `${nodePtyPackage.version}\n`);
  run("pnpm", ["runtime:build", "--", "--target", "controlled-instance"], {
    env: { ...process.env, TASK_HANDOFF_VERSION: version },
  });
  run("pnpm", ["runtime:artifact", "--", "--version", version, "--prebuilds-dir", prebuildsDir]);
  verifyArtifact();
}

const command = process.argv[2] || "prepare";
if (command === "prepare") prepareArtifact();
else if (command === "verify") verifyArtifact();
else throw new Error(`Unknown desktop runtime command: ${command}`);
