const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const deployment = fs.readFileSync(path.join(root, "scripts", "update-test-control-plane.sh"), "utf8");
const prepareFunction = deployment.match(/^build_remote_desktop_package\(\) \{\n[\s\S]*?^\}\n/m)?.[0];
const nextVersionFunction = deployment.match(/^next_version_suffix\(\) \{\n[\s\S]*?^\}\n/m)?.[0];

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-test-deploy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packages = path.join(directory, "packages");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(packages);
  fs.mkdirSync(bin);
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, "#!/bin/sh\nexit 97\n", { mode: 0o755 });

  const version = options.version ?? "1.2.3";
  const arch = "arm64";
  const tarball = `task-handoff-remote-desktop-linux-${arch}-${version}.tgz`;
  const metadataName = `task-handoff-remote-desktop-linux-${arch}-${version}.metadata.json`;
  const packageFile = path.join(packages, tarball);
  fs.writeFileSync(packageFile, options.packageContents ?? "test package");
  fs.writeFileSync(path.join(packages, metadataName), `${JSON.stringify({
    version: options.metadataVersion ?? version,
    platform: "linux",
    arch,
    package: `@task-handoff/remote-desktop-linux-${arch}`,
    integrity: options.integrity ?? `sha512-${crypto.createHash("sha512").update(fs.readFileSync(packageFile)).digest("base64")}`,
  }, null, 2)}\n`);

  const script = path.join(directory, "run.sh");
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
INSTALL_REMOTE_DESKTOP=1
ROOT=${directory}
REMOTE_DESKTOP_ARCH=arm64
VERSION=${version}
REMOTE_DESKTOP_PACKAGE_DIR=${packages}
REMOTE_DESKTOP_PACKAGE_BASENAME=${tarball}
REMOTE_DESKTOP_METADATA_BASENAME=${metadataName}
PATH=${bin}:$PATH
log() { :; }
require_command() { command -v "$1" >/dev/null 2>&1; }
${prepareFunction}
build_remote_desktop_package
`, { mode: 0o755 });
  return { script, docker };
}

test("test deployment reuses a complete local desktop package without Docker", t => {
  const f = fixture(t);
  const result = spawnSync("bash", [f.script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("test deployment rebuilds a local desktop package when reuse metadata is stale", t => {
  const f = fixture(t, { metadataVersion: "1.2.2" });
  const result = spawnSync("bash", [f.script], { encoding: "utf8" });
  assert.equal(result.status, 97, `the fake Docker command should be reached for a rebuild\n${result.stderr}`);
});

test("test deployment resolves the desktop package for the target host architecture", () => {
  assert.ok(prepareFunction, "build_remote_desktop_package must remain available to the deployment script");
  assert.match(deployment, /REMOTE_DESKTOP_PACKAGE_BASENAME="task-handoff-remote-desktop-linux-\$REMOTE_DESKTOP_ARCH-\$VERSION\.tgz"/);
  assert.match(deployment, /REMOTE_DESKTOP_METADATA_BASENAME="task-handoff-remote-desktop-linux-\$REMOTE_DESKTOP_ARCH-\$VERSION\.metadata\.json"/);
  assert.match(prepareFunction, /x64\) toolchain=x86_64-unknown-linux-gnu; docker_arch=amd64/);
  assert.match(prepareFunction, /arm64\) toolchain=aarch64-unknown-linux-gnu; docker_arch=arm64/);
  assert.match(prepareFunction, /-e REMOTE_DESKTOP_ARCH="\$REMOTE_DESKTOP_ARCH"/);
  assert.doesNotMatch(prepareFunction, /Cannot reuse .*desktop package artifacts are missing/);
});

test("test deployment verifies the running component comes from the installed package", () => {
  assert.match(deployment, /running_binary_matches\(\)/);
  assert.match(deployment, /for link in \/proc\/\[0-9\]\*\/exe/);
  assert.match(deployment, /&& running_binary_matches; then/);
  assert.match(deployment, /did not become ready from the installed package/);
});

test("test deployment version selection compares version suffixes numerically", t => {
  assert.ok(nextVersionFunction, "next_version_suffix must remain available to the deployment script");
  assert.match(deployment, /\| next_version_suffix "\$VERSION_PREFIX"/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-test-version-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "next-version.sh");
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
${nextVersionFunction}
printf '%s\n' "$@" | next_version_suffix "0.0.25-local.20261126."
`, { mode: 0o755 });
  const result = spawnSync("bash", [script,
    "release/runtime-artifacts/controlled-instance-runtime-0.0.25-local.20261126.9-linux-universal.tar.gz",
    "release/npm/artifacts/task-handoff-server-0.0.25-local.20261126.17.tgz",
    "/usr/local/lib/node_modules/@task-handoff/.server-0.0.25-local.20261126.29-backup-20261126130825",
    "0.0.25-local.20261126.30",
    "0.0.25-local.20261126.27",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "31");
  const empty = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "1");
});

test("test deployment does not embed component package metadata into runtime artifacts", () => {
  assert.doesNotMatch(deployment, /prepare_remote_desktop_release_metadata/);
  assert.doesNotMatch(deployment, /shared\/remote-desktop-packages\.json/);
  assert.doesNotMatch(deployment, /scripts\/remote-desktop-packages\.mjs metadata/);
  assert.equal(fs.existsSync(path.join(root, "shared", "remote-desktop-packages.json")), false);
});
