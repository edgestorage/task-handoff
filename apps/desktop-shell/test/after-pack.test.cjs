const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeNodePtyRuntime, validateDesktopServerRuntime, validateDesktopTrayResource } = require("../scripts/after-pack.cjs");

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

test("afterPack rejects an incomplete unpacked desktop server runtime", () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-after-pack-runtime-"));
  const runtimeRoot = path.join(appOutDir, "TaskHandoff.app", "Contents", "Resources", "app.asar.unpacked");
  fs.mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "bin", "task-handoff.js"), "require('../dist/cli');\n");
  const context = {
    appOutDir,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "TaskHandoff" } },
  };
  assert.throws(
    () => validateDesktopServerRuntime(context),
    /dist\/cli\.js, node_modules\/fastify\/package\.json/,
  );
});

test("afterPack requires the dedicated transparent tray icon", () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-after-pack-tray-"));
  const resources = path.join(appOutDir, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const context = {
    appOutDir,
    electronPlatformName: "win32",
    packager: { appInfo: { productFilename: "TaskHandoff" } },
  };
  assert.throws(() => validateDesktopTrayResource(context), /tray icon is missing/);
  fs.writeFileSync(path.join(resources, "tray-icon.png"), "icon");
  assert.doesNotThrow(() => validateDesktopTrayResource(context));
});
