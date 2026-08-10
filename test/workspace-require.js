const Module = require("node:module");
const path = require("node:path");

let registered = false;

function registerWorkspaceRequire(rootDir = path.resolve(__dirname, "..")) {
  if (registered) {
    return;
  }
  registered = true;
  const originalResolveFilename = Module._resolveFilename;
  const workspacePackageAliases = new Map([
    ["@task-handoff/ai-session-runtime", path.join(rootDir, "packages/ai-session-runtime/src/index.ts")],
    ["@task-handoff/ai-session-runtime/", path.join(rootDir, "packages/ai-session-runtime/src/")],
    ["@task-handoff/cloud-contracts", path.join(rootDir, "packages/cloud-contracts/src/index.ts")],
    ["@task-handoff/cloud-contracts/", path.join(rootDir, "packages/cloud-contracts/src/")],
    ["@task-handoff/core", path.join(rootDir, "packages/core/src/index.ts")],
    ["@task-handoff/core/", path.join(rootDir, "packages/core/src/")],
    ["@task-handoff/protocol", path.join(rootDir, "packages/protocol/src/index.ts")],
    ["@task-handoff/protocol/", path.join(rootDir, "packages/protocol/src/")],
  ]);
  Module._resolveFilename = function resolveWorkspacePackage(request, parent, isMain, options) {
    for (const [prefix, target] of workspacePackageAliases) {
      if (prefix.endsWith("/") && request.startsWith(prefix)) {
        return `${target}${request.slice(prefix.length)}.ts`;
      }
      if (!prefix.endsWith("/") && request === prefix) {
        return target;
      }
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

module.exports = { registerWorkspaceRequire };
