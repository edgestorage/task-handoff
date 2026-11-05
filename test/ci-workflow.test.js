const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("CI packs and verifies both implementations independently", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /implementation: \[node, rust\]/);
  assert.match(workflow, /TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION: \$\{\{ matrix\.implementation \}\}/);
  assert.match(workflow, /if: matrix\.implementation == 'rust'/);
  assert.match(workflow, /pnpm runtime:build -- --target controlled-instance/);
  assert.match(workflow, /pnpm runtime:artifact -- --version/);
  assert.match(workflow, /run: pnpm runtime:pack/);
  assert.match(workflow, /Verify selected controlled instance artifact/);
  assert.doesNotMatch(workflow, /rust-controlled-instance-artifacts|node-rollback-artifacts/);
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
