const fs = require("node:fs");
const path = require("node:path");

const NODE_PTY_HELPER_REWRITE = "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
const NODE_PTY_HELPER_REWRITE_SAFE = "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');";

function resourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function normalizeNodePtyRuntime(context) {
  const nodePtyRoot = path.join(resourcesDirectory(context), "app.asar.unpacked", "node_modules", "node-pty");
  fs.rmSync(path.join(nodePtyRoot, "build"), { recursive: true, force: true });

  const unixTerminalPath = path.join(nodePtyRoot, "lib", "unixTerminal.js");
  const source = fs.readFileSync(unixTerminalPath, "utf8");
  if (source.includes(NODE_PTY_HELPER_REWRITE_SAFE)) {
    return;
  }
  if (!source.includes(NODE_PTY_HELPER_REWRITE)) {
    throw new Error(`Unsupported node-pty helper path implementation in ${unixTerminalPath}`);
  }
  fs.writeFileSync(unixTerminalPath, source.replace(NODE_PTY_HELPER_REWRITE, NODE_PTY_HELPER_REWRITE_SAFE));
}

function validateDesktopServerRuntime(context) {
  const runtimeRoot = path.join(resourcesDirectory(context), "app.asar.unpacked");
  const requiredFiles = [
    "bin/task-handoff.js",
    "dist/cli.js",
    "node_modules/fastify/package.json",
  ];
  const missing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(runtimeRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`Packaged desktop server runtime is incomplete: ${missing.join(", ")}`);
  }
}

async function afterPack(context) {
  validateDesktopServerRuntime(context);
  normalizeNodePtyRuntime(context);
}

module.exports = afterPack;
module.exports.normalizeNodePtyRuntime = normalizeNodePtyRuntime;
module.exports.validateDesktopServerRuntime = validateDesktopServerRuntime;
