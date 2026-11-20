const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { observeProcessRestart } = require("./fixtures/controlled-instance-process-restart-parity.js");

const root = path.join(__dirname, "..");
const fixturePath = path.join(root, "controlled-instance-rs/crates/instance/tests/fixtures/process-restart-parity.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const nodeBundle = path.join(root, "dist/controlled-instance-cli.js");
const rustBinary = path.join(root, "controlled-instance-rs/target/debug/controlled-instance-rs");
const missingBinaries = [nodeBundle, rustBinary].filter((file) => !fs.existsSync(file));

test(
  "U03.2 Node and Rust restore process state after SIGTERM and data-dir restart",
  { skip: missingBinaries.length ? `missing runtime binaries: ${missingBinaries.join(", ")}` : false },
  async () => {
    const node = await observeProcessRestart({
      kind: "node",
      command: process.execPath,
      args: [nodeBundle],
      cwd: root,
    }, fixture.input);
    assert.deepEqual(node, fixture.expected, "Node process restart output must match the fixed Node golden");

    const rust = await observeProcessRestart({
      kind: "rust",
      command: rustBinary,
      args: [],
      cwd: root,
    }, fixture.input);
    assert.deepEqual(rust, fixture.expected, "Rust process restart output must match the fixed Node golden");
  },
);
