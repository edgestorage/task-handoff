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
  const missingBootstrapAssets = missingDockerBootstrapAssets(context);
  if (missingBootstrapAssets.length > 0) {
    throw new Error(`Packaged desktop node agent bootstrap assets are incomplete: missing ${missingBootstrapAssets.join(", ")}`);
  }
}

// The node agent mounts these files into every Docker container, so any script the
// repository ships in docker/ must survive as a real file outside the asar archive.
function missingDockerBootstrapAssets(context) {
  const projectDir = context.packager?.projectDir;
  if (!projectDir) {
    throw new Error("Packager project directory is unavailable; cannot verify node agent bootstrap assets.");
  }
  const sourceDir = path.join(projectDir, "docker");
  const unpackedDir = path.join(resourcesDirectory(context), "app.asar.unpacked", "docker");
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:sh|mjs|js)$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !fs.existsSync(path.join(unpackedDir, name)))
    .map((name) => `docker/${name}`)
    .sort();
}

function validateDesktopTrayResource(context) {
  const iconPath = path.join(resourcesDirectory(context), "tray-icon.png");
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Packaged desktop tray icon is missing: ${iconPath}`);
  }
}

async function afterPack(context) {
  validateDesktopServerRuntime(context);
  validateDesktopTrayResource(context);
  normalizeNodePtyRuntime(context);
}

module.exports = afterPack;
module.exports.normalizeNodePtyRuntime = normalizeNodePtyRuntime;
module.exports.validateDesktopServerRuntime = validateDesktopServerRuntime;
module.exports.validateDesktopTrayResource = validateDesktopTrayResource;
module.exports.missingDockerBootstrapAssets = missingDockerBootstrapAssets;
