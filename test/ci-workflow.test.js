const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("CI assembles Rust runtime packages and the Node rollback artifact from both Linux architectures", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

  for (const identity of ["linux-x64", "linux-arm64"]) {
    const [platform, arch] = identity.split("-");
    assert.match(workflow, new RegExp(`platform: ${platform}\\n\\s+arch: ${arch}`));
  }
  assert.match(workflow, /node:24-bullseye/);
  assert.match(workflow, /runtime-packages:\n\s+needs: \[node-pty-prebuilds, controlled-instance-rust-binaries\]/);
  assert.match(workflow, /pattern: ci-node-pty-prebuild-\*/);
  assert.match(workflow, /path: release\/node-pty-prebuilds[\s\S]*merge-multiple: true/);
  assert.match(workflow, /pnpm runtime:artifact -- --version "\$version" --prebuilds-dir release\/node-pty-prebuilds/);
  assert.equal((workflow.match(/pnpm runtime:pack/g) || []).length, 1);
  assert.ok(workflow.indexOf("pattern: ci-node-pty-prebuild-*") < workflow.indexOf("pnpm runtime:artifact"));
  assert.ok(workflow.indexOf("pnpm runtime:artifact") < workflow.indexOf("run: pnpm runtime:pack"));
  assert.match(workflow, /cargo build --locked --release -p controlled-instance-cli/);
  assert.match(workflow, /pattern: ci-rust-controlled-instance-linux-\*/);
  assert.match(workflow, /path: release\/rust-controlled-instance-binaries[\s\S]*merge-multiple: true/);
  assert.match(workflow, /Build and verify Linux Node rollback artifact[\s\S]*?TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION: node/);
  assert.match(workflow, /mv release\/runtime-artifacts release\/node-rollback-artifacts/);
  assert.ok(workflow.indexOf("pattern: ci-rust-controlled-instance-linux-*") < workflow.indexOf("run: pnpm runtime:pack"));
  assert.match(workflow, /Verify Rust controlled instance artifact/);
});

test("CI uses the installed Rust toolchain for cross-target checks and linting", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const toolchain = fs.readFileSync(path.join(root, "controlled-instance-rs", "rust-toolchain.toml"), "utf8");
  const version = /channel = "([^"]+)"/.exec(toolchain)[1];
  assert.ok(workflow.includes(`RUSTUP_TOOLCHAIN: ${version}`));
  assert.match(workflow, /apt-get install --no-install-recommends -y gcc-mingw-w64-x86-64/);
  assert.ok(workflow.indexOf("Install Windows C cross-compiler") < workflow.indexOf("name: Check Windows target"));
  assert.ok(workflow.includes(`rustup toolchain install ${version} --profile minimal --component rustfmt --component clippy --target x86_64-pc-windows-gnu`));
});
