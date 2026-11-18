#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { packRemoteDesktopPackage, remoteDesktopExecutablePath } from "./remote-desktop-packages.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "remote-desktop";
const COMPONENT_BIN = "task-handoff-desktop-streaming";
const COMPONENT_BINARY = process.platform === "win32" ? `${COMPONENT_BIN}.exe` : COMPONENT_BIN;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
}

function parseArguments(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") { values.help = true; continue; }
    if (key === "--debug") { values.debug = true; continue; }
    if (key === "--no-install") { values.install = false; continue; }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

export function defaultNodeAgentDataDir(env = process.env) {
  const desktopDataDir = path.resolve(env.TASK_HANDOFF_DESKTOP_DATA_DIR || env.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "desktop-control-plane"));
  return path.resolve(env.TASK_HANDOFF_DESKTOP_NODE_AGENT_DATA_DIR || env.TASK_HANDOFF_NODE_AGENT_DATA_DIR || path.join(desktopDataDir, "node-agent"));
}

export function discoverLocalInstances(nodeAgentDataDir, instanceId) {
  const localInstances = path.join(path.resolve(nodeAgentDataDir), "local-instances");
  if (!fs.existsSync(localInstances)) throw new Error(`Node Agent local instances directory is missing: ${localInstances}`);
  if (instanceId) {
    if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error(`Invalid instance id: ${instanceId}`);
    const directory = path.join(localInstances, instanceId);
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Local instance is missing: ${instanceId}`);
    return [{ id: instanceId, directory }];
  }
  const instances = fs.readdirSync(localInstances, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ id: entry.name, directory: path.join(localInstances, entry.name) }))
    .filter(({ directory }) => fs.statSync(path.join(directory, "managed-apps"), { throwIfNoEntry: false })?.isDirectory());
  if (!instances.length) throw new Error(`No local instances with managed-apps were found under ${localInstances}. Start Desktop once before installing the component.`);
  return instances;
}

function walkOwnedFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Remote desktop package contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...walkOwnedFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Remote desktop package contains an unsupported entry: ${relative}`);
  }
  return files;
}

export async function installRemoteDesktopPackage({ archive, metadata, instanceDir }) {
  const installBaseDir = path.join(path.resolve(instanceDir), "managed-apps");
  const nativeRoot = path.join(installBaseDir, "native");
  const installRoot = path.join(nativeRoot, APP_ID);
  const staging = path.join(nativeRoot, `.${APP_ID}-build-${process.pid}-${randomUUID()}`);
  const previous = `${installRoot}.previous-${randomUUID()}`;
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await tar.x({ file: path.resolve(archive), cwd: staging, strip: 1 });
    const executable = remoteDesktopExecutablePath(metadata.platform);
    const launchPath = path.join(staging, executable);
    const file = fs.lstatSync(launchPath, { throwIfNoEntry: false });
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error("Remote desktop package has no usable launcher inside its install root.");
    fs.chmodSync(launchPath, 0o755);
    const verify = spawnSync(launchPath, ["--version"], { cwd: staging, encoding: "utf8", timeout: 15_000 });
    if (verify.error) throw verify.error;
    if (verify.status !== 0) throw new Error(`Installed remote desktop binary failed its version check: ${(verify.stderr || verify.stdout || "").trim()}`);
    const files = [...new Set([...walkOwnedFiles(staging), "managed-app.json"])].sort();
    const manifest = {
      schemaVersion: 1,
      appId: APP_ID,
      version: metadata.version,
      package: metadata.package,
      packageVersion: metadata.version,
      integrity: metadata.integrity,
      installRoot,
      launchPath: executable,
      files,
    };
    fs.writeFileSync(path.join(staging, "managed-app.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fsp.mkdir(nativeRoot, { recursive: true, mode: 0o700 });
    const hadPrevious = fs.existsSync(installRoot);
    if (hadPrevious) await fsp.rename(installRoot, previous);
    try {
      await fsp.rename(staging, installRoot);
    } catch (error) {
      if (!fs.existsSync(installRoot) && fs.existsSync(previous)) await fsp.rename(previous, installRoot);
      throw error;
    }
    if (hadPrevious) await fsp.rm(previous, { recursive: true, force: true });
    return { instanceId: path.basename(path.resolve(instanceDir)), installRoot, version: verify.stdout.trim() };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

function usage() {
  return "Usage: pnpm remote-desktop:build [-- --debug] [-- --no-install] [-- --instance <id>] [-- --node-agent-data-dir <dir>] [-- --output <dir>] [-- --version <version>] [-- --toolchain <toolchain>] [-- --features <features>]";
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!SUPPORTED_PLATFORMS.has(process.platform) || !SUPPORTED_ARCHES.has(process.arch) || (process.platform === "win32" && process.arch !== "x64")) {
    throw new Error(`Remote desktop builds are supported on darwin/linux x64/arm64 and win32/x64, not ${process.platform}/${process.arch}.`);
  }
  const version = args.version || process.env.TASK_HANDOFF_VERSION || JSON.parse(fs.readFileSync(path.join(root, "packages", "controlled-instance", "package.json"), "utf8")).version;
  const toolchain = args.toolchain || process.env.RUSTUP_TOOLCHAIN || "1.95.0";
  const profile = args.debug ? "debug" : "release";
  const cargoArgs = [`+${toolchain}`, "build", "--manifest-path", path.join(root, "remote-desktop-rs", "Cargo.toml"), "-p", "desktop-streaming", "--bin", COMPONENT_BIN];
  if (!args.debug) cargoArgs.push("--release");
  if (args.features) cargoArgs.push("--features", args.features);
  console.log(`[remote-desktop] building ${profile} for ${process.platform}/${process.arch} with Rust ${toolchain}`);
  run("cargo", cargoArgs, { env: { ...process.env, TASK_HANDOFF_REMOTE_DESKTOP_VERSION: version } });
  const binary = path.join(root, "remote-desktop-rs", "target", profile, COMPONENT_BINARY);
  if (!fs.existsSync(binary)) throw new Error(`Cargo did not produce ${binary}.`);
  const packed = await packRemoteDesktopPackage({
    version,
    platform: process.platform,
    arch: process.arch,
    binary,
    output: args.output || path.join(root, "release", "remote-desktop-packages"),
  });
  console.log(`[remote-desktop] package ${packed.archive}`);
  if (args.install === false) return;
  const nodeAgentDataDir = args["node-agent-data-dir"] || defaultNodeAgentDataDir();
  const instances = discoverLocalInstances(nodeAgentDataDir, args.instance);
  for (const instance of instances) {
    const installed = await installRemoteDesktopPackage({ archive: packed.archive, metadata: packed.metadata, instanceDir: instance.directory });
    console.log(`[remote-desktop] installed ${installed.version} in ${instance.id}: ${installed.installRoot}`);
  }
  console.log("[remote-desktop] restart Desktop or the remote desktop session to load the installed component.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
