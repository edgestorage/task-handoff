import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const workspacePackages = new Map();

for (const workspaceDir of ["apps", "packages"]) {
  for (const entry of readdirSync(path.join(root, workspaceDir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, workspaceDir, entry.name, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      workspacePackages.set(manifest.name, manifest);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function runtimeDependencies(workspaceRoots, extraNames = []) {
  const dependencies = new Map();
  const pending = [...workspaceRoots];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const manifest = workspacePackages.get(name);
    if (!manifest) throw new Error(`Unknown runtime workspace dependency: ${name}`);
    for (const [dependency, version] of Object.entries(manifest.dependencies || {})) {
      if (workspacePackages.has(dependency)) {
        pending.push(dependency);
      } else {
        dependencies.set(dependency, version);
      }
    }
  }
  for (const name of extraNames) {
    const version = rootPackage.dependencies[name];
    if (!version) throw new Error(`Runtime dependency ${name} is not declared in the root package.json.`);
    dependencies.set(name, version);
  }
  return Object.fromEntries([...dependencies].sort(([left], [right]) => left.localeCompare(right)));
}

export const runtimePackages = {
  server: {
    packageName: "@task-handoff/server",
    description: "Complete TaskHandoff server package.",
    input: "apps/cli/src/runtime/server.ts",
    entryFile: "server-cli.js",
    binName: "task-handoff",
    dependencies: {},
    aggregateDependencies: [
      "@task-handoff/control-plane",
      "@task-handoff/node-agent",
      "@task-handoff/controlled-instance",
    ],
  },
  "control-plane": {
    packageName: "@task-handoff/control-plane",
    description: "Prebuilt TaskHandoff control plane runtime.",
    input: "apps/cli/src/runtime/control-plane.ts",
    entryFile: "cli.js",
    binName: "task-handoff-control-plane",
    uiDir: "packages/control-plane-ui/dist",
    dependencies: runtimeDependencies(["@task-handoff/control-plane"], ["commander"]),
  },
  "node-agent": {
    packageName: "@task-handoff/node-agent",
    description: "Prebuilt TaskHandoff node agent runtime.",
    input: "apps/cli/src/runtime/node-agent.ts",
    entryFile: "cli.js",
    updateWorkerInput: "scripts/node-update-worker.cts",
    updateWorkerEntryFile: "node-update-worker.js",
    binName: "task-handoff-node-agent",
    dependencies: runtimeDependencies(["@task-handoff/control-plane"], ["commander"]),
  },
  "controlled-instance": {
    packageName: "@task-handoff/controlled-instance",
    description: "Prebuilt TaskHandoff controlled instance runtime.",
    input: "apps/controlled-instance-image/src/cli.ts",
    entryFile: "controlled-instance-cli.js",
    binName: "task-handoff-controlled-instance",
    uiDir: "packages/controlled-instance-ui/dist",
    // The controlled-instance application is shipped by node-agent as one
    // portable bundle. Keep only the native dependency external; Rollup owns
    // the complete JavaScript dependency graph so the artifact does not carry
    // a workspace-wide pnpm virtual store.
    dependencies: {
      "node-pty": rootPackage.dependencies["node-pty"],
    },
  },
};
