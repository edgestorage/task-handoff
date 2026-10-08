#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { list } from "tar";
import { runtimePackages } from "../runtime-packages.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveFeatureFlags } = createRequire(import.meta.url)("../shared/feature-flags.cjs");
const builtinProjects = await import(pathToFileURL(path.join(root, "packages/control-plane/src/node-agent/builtin-projects/assets.ts")).href);
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
      "docker/node-agent-unix-proxy.mjs",
      "docker/runtime-installer.mjs",
      "docker/git-provision.sh",
      ...(definition.standaloneInputs || []).map((entry) => `docker/${entry.entryFile}`),
    ] : []),
  ];
}

/**
 * Non-executable files that must ship with a runtime package. The built-in
 * project catalog only ships when the `builtinProjects` feature flag enabled
 * this build, so the required manifests are derived from what the build
 * materialized instead of naming one specific project.
 */
function requiredAssetPaths(name) {
  if (name !== "node-agent" || !resolveFeatureFlags().builtinProjects) return [];
  const source = path.join(root, "builtin-projects");
  const manifests = fs.existsSync(source)
    ? fs.readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && fs.existsSync(path.join(source, entry.name, builtinProjects.BUILTIN_PROJECT_MANIFEST_FILE)))
      .map((entry) => `builtin-projects/${entry.name}/${builtinProjects.BUILTIN_PROJECT_MANIFEST_FILE}`)
    : [];
  if (!manifests.length) throw new Error("Built-in projects are enabled but no project was materialized; run node scripts/sync-builtin-projects.mjs first.");
  return manifests;
}

async function verifyArchiveExecutables(name, definition, archivePath) {
  const requiredNativeFiles = definition.bundledNativeDependencies?.includes("node-pty")
    ? [
        "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        "node_modules/node-pty/prebuilds/linux-arm64/pty.node",
      ]
    : [];
  const missing = new Set([...requiredExecutablePaths(name, definition), ...requiredAssetPaths(name), ...requiredNativeFiles]);
  await list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const relativePath = entry.path.replace(/^package\//, "");
      if (!missing.has(relativePath)) return;
      if (requiredExecutablePaths(name, definition).includes(relativePath) && (!entry.mode || (entry.mode & 0o111) === 0)) {
        throw new Error(`Runtime package ${name} archive entry is not executable: ${relativePath}`);
      }
      missing.delete(relativePath);
    },
  });
  if (missing.size) throw new Error(`Runtime package ${name} archive is missing required files: ${[...missing].join(", ")}`);
}

for (const name of selected) {
  fs.rmSync(path.join(root, "release", "npm", name), { recursive: true, force: true });
}

// Built-in projects are pulled from the published skill release at build time,
// so the packaged catalog always follows the product source instead of a
// committed snapshot.
if (selected.includes("node-agent")) {
  run(process.execPath, ["scripts/sync-builtin-projects.mjs"]);
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
