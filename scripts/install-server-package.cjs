#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function resolvePackageRoot(packageName) {
  const manifest = require.resolve(`${packageName}/package.json`, { paths: [__dirname] });
  return path.dirname(manifest);
}

function packageBin(packageName, binName) {
  const packageRoot = resolvePackageRoot(packageName);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const relativeBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (!relativeBin) {
    throw new Error(`${packageName} does not provide the ${binName} executable.`);
  }
  return path.join(packageRoot, relativeBin);
}

let controlPlane;
let nodeAgent;
let controlledInstance;
try {
  controlPlane = packageBin("@task-handoff/control-plane", "task-handoff-control-plane");
  nodeAgent = packageBin("@task-handoff/node-agent", "task-handoff-node-agent");
  controlledInstance = packageBin("@task-handoff/controlled-instance", "task-handoff-controlled-instance");
} catch (error) {
  console.error(`TaskHandoff server package is incomplete: ${error.message}`);
  process.exit(1);
}

const result = spawnSync(
  path.join(__dirname, "task-handoff-install-server-services"),
  [
    "--control-plane-bin",
    controlPlane,
    "--node-agent-bin",
    nodeAgent,
    "--controlled-instance-bin",
    controlledInstance,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to start the TaskHandoff service installer: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
