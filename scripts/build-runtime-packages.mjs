#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { list } from "tar";
import { runtimePackages } from "../runtime-packages.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCache = path.join(os.tmpdir(), "task-handoff-npm-cache");
const targetNames = Object.keys(runtimePackages);
const cliArgv = process.argv[2] === "--" ? [...process.argv.slice(0, 2), ...process.argv.slice(3)] : process.argv;
const options = new Command()
  .name("build-runtime-packages")
  .description("Build and optionally pack TaskHandoff runtime packages.")
  .addOption(new Option("--target <target>", "build one runtime package").choices(targetNames))
  .option("--pack", "create npm package archives")
  .parse(cliArgv)
  .opts();
const target = options.target;
const shouldPack = options.pack;
const selected = target ? Object.keys(runtimePackages).filter((name) => name === target) : Object.keys(runtimePackages);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function requiredExecutablePaths(name, definition) {
  return [
    `bin/${definition.binName}`,
    ...(name === "server" ? ["bin/task-handoff-install-server", "bin/task-handoff-install-server-services"] : []),
    ...(definition.updateWorkerInput ? ["bin/task-handoff-node-update-worker"] : []),
    ...(name === "node-agent" ? [
      "docker/entrypoint.sh",
      "docker/instance-launcher.sh",
      "docker/runtime-installer.mjs",
    ] : []),
  ];
}

async function verifyArchiveExecutables(name, definition, archivePath) {
  const missing = new Set(requiredExecutablePaths(name, definition));
  await list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const relativePath = entry.path.replace(/^package\//, "");
      if (!missing.has(relativePath)) return;
      if (!entry.mode || (entry.mode & 0o111) === 0) {
        throw new Error(`Runtime package ${name} archive entry is not executable: ${relativePath}`);
      }
      missing.delete(relativePath);
    },
  });
  if (missing.size) throw new Error(`Runtime package ${name} archive is missing executables: ${[...missing].join(", ")}`);
}

for (const name of selected) {
  fs.rmSync(path.join(root, "release", "npm", name), { recursive: true, force: true });
}

if (selected.includes("control-plane")) {
  run("pnpm", ["run", "control-plane-ui:build"]);
}
if (selected.includes("controlled-instance")) {
  run("pnpm", ["run", "controlled-instance-ui:build"]);
}

if (selected.some((name) => runtimePackages[name].input)) {
  run("pnpm", ["exec", "rollup", "-c"], {
    env: {
      ...process.env,
      TASK_HANDOFF_ROLLUP_TARGET: "runtime-packages",
      ...(target ? { TASK_HANDOFF_RUNTIME_PACKAGE: target } : {}),
    },
  });
}
run(process.execPath, ["scripts/prepare-runtime-packages.mjs", ...(target ? [target] : [])]);
run(process.execPath, ["scripts/check-runtime-packages.mjs", ...(target ? [target] : [])]);

if (shouldPack) {
  const artifactDir = path.join(root, "release", "npm", "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const name of selected) {
    const prefix = runtimePackages[name].packageName.replace(/^@/, "").replace("/", "-");
    for (const entry of fs.readdirSync(artifactDir)) {
      if (entry.startsWith(`${prefix}-`) && entry.endsWith(".tgz")) {
        fs.rmSync(path.join(artifactDir, entry));
      }
    }
    run("npm", ["pack", "--pack-destination", artifactDir, path.join(root, "release", "npm", name)], {
      env: { ...process.env, npm_config_cache: npmCache },
    });
    const version = JSON.parse(fs.readFileSync(path.join(root, "release", "npm", name, "package.json"), "utf8")).version;
    await verifyArchiveExecutables(name, runtimePackages[name], path.join(artifactDir, `${prefix}-${version}.tgz`));
  }
}
