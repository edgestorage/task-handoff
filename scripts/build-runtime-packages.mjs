#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
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
  }
}
