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
  assert.match(workflow, /run: pnpm runtime:pack:controlled-instance/);
  assert.doesNotMatch(workflow, /run: pnpm runtime:pack\s*$/m);
  assert.match(workflow, /Verify selected controlled instance artifact/);
  assert.doesNotMatch(workflow, /rust-controlled-instance-artifacts|node-rollback-artifacts/);
});

test("CI splits quality checks into parallel jobs behind the aggregate gate", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /^  quality-node:/m);
  assert.match(workflow, /^  quality-client:/m);
  assert.match(workflow, /^  quality-static:/m);
  assert.match(workflow, /needs: \[quality-node, quality-client, quality-static\]/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /NODE_RESULT: \$\{\{ needs\['quality-node'\]\.result \}\}/);
  assert.match(workflow, /test "\$NODE_RESULT" = success/);
  assert.match(workflow, /fetch-depth: 0/);
  for (const step of [
    "Test Node packages",
    "Test Control Plane client",
    "Test Control Plane UI",
    "Test mobile",
    "pnpm check",
    "pnpm web:typecheck",
    "Check controlled instance Rust migration boundary",
  ]) {
    assert.ok(workflow.includes(step), `${step} must remain in the quality jobs`);
  }
});

test("CI caches the Rust release target and cargo registry per architecture", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /uses: actions\/cache@v6/);
  assert.match(workflow, /controlled-instance-rs\/target\/linux-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /hashFiles\('controlled-instance-rs\/Cargo\.lock'\)/);
  assert.match(workflow, /CARGO_HOME=\/cargo-home/);
  assert.match(workflow, /--user "\$\(id -u\):\$\(id -g\)"/);
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
