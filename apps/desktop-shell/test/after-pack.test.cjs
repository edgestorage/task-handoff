const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeNodePtyRuntime } = require("../scripts/after-pack.cjs");

test("afterPack forces node-pty to use its prebuild without doubling app.asar.unpacked", () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-after-pack-"));
  const nodePtyRoot = path.join(appOutDir, "TaskHandoff.app", "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty");
  const libDir = path.join(nodePtyRoot, "lib");
  fs.mkdirSync(path.join(nodePtyRoot, "build", "Release"), { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(nodePtyRoot, "build", "Release", "pty.node"), "rebuilt");
  fs.writeFileSync(
    path.join(libDir, "unixTerminal.js"),
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\n",
  );

  const context = {
    appOutDir,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "TaskHandoff" } },
  };
  normalizeNodePtyRuntime(context);
  normalizeNodePtyRuntime(context);

  assert.equal(fs.existsSync(path.join(nodePtyRoot, "build")), false);
  assert.match(fs.readFileSync(path.join(libDir, "unixTerminal.js"), "utf8"), /app\\\.asar\(\?!\\\.unpacked\)/);
});
