#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_PREFIX = "@task-handoff/remote-desktop";
const EXECUTABLE = "bin/task-handoff-desktop-streaming";
const PLATFORMS = new Set(["linux", "darwin"]);
const ARCHES = new Set(["x64", "arm64"]);
const COMPLETE_TARGETS = ["linux/x64", "linux/arm64", "darwin/x64", "darwin/arm64"];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function remoteDesktopPackageName(platform, arch) {
  if (!PLATFORMS.has(platform) || !ARCHES.has(arch)) throw new Error(`Unsupported remote desktop package target: ${platform}/${arch}`);
  return `${PACKAGE_PREFIX}-${platform}-${arch}`;
}

function parseArguments(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const values = { command: argv[0] ?? "help" };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--complete") {
      values.complete = true;
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

function exactVersion(value) {
  const version = value?.trim();
  if (!version || !VERSION.test(version)) throw new Error("--version must be an exact semver version.");
  return version;
}

function npmPack(packageDir, outputDir) {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", outputDir, packageDir], {
    cwd: root,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(os.tmpdir(), "task-handoff-npm-cache") },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "npm pack failed").trim());
  let entries;
  try { entries = JSON.parse(result.stdout); } catch { throw new Error(`npm pack returned invalid JSON: ${result.stdout}`); }
  const filename = entries?.[0]?.filename;
  if (typeof filename !== "string" || path.basename(filename) !== filename) throw new Error("npm pack did not return a package filename.");
  return path.join(outputDir, filename);
}

export async function packRemoteDesktopPackage(options) {
  const version = exactVersion(options.version);
  const platform = options.platform;
  const arch = options.arch;
  const name = remoteDesktopPackageName(platform, arch);
  const binary = path.resolve(options.binary);
  const outputDir = path.resolve(options.output);
  if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) throw new Error(`Remote desktop binary is missing: ${binary}`);
  await fsp.mkdir(outputDir, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "task-handoff-remote-desktop-package-"));
  try {
    const packageDir = path.join(work, "package");
    await fsp.mkdir(path.join(packageDir, "bin"), { recursive: true });
    await fsp.copyFile(binary, path.join(packageDir, EXECUTABLE));
    await fsp.chmod(path.join(packageDir, EXECUTABLE), 0o755);
    await fsp.writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
      name,
      version,
      description: `TaskHandoff remote desktop component for ${platform}/${arch}.`,
      license: "Apache-2.0",
      os: [platform],
      cpu: [arch],
      bin: { "task-handoff-desktop-streaming": EXECUTABLE },
      files: ["bin", "README.md"],
      publishConfig: { access: "public" },
    }, null, 2)}\n`);
    await fsp.writeFile(path.join(packageDir, "README.md"), `# ${name}\n\nNative TaskHandoff remote desktop component for ${platform}/${arch}. The managed app installer treats npm as an artifact source and does not run npm lifecycle scripts.\n`);

    const prefix = name.replace(/^@/, "").replace("/", "-");
    for (const entry of await fsp.readdir(outputDir)) {
      if ((entry.startsWith(`${prefix}-`) && entry.endsWith(".tgz")) || entry === `${prefix}-${version}.metadata.json`) {
        await fsp.rm(path.join(outputDir, entry), { force: true });
      }
    }
    const archive = npmPack(packageDir, outputDir);
    const bytes = await fsp.readFile(archive);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const metadata = { version, platform, arch, package: name, integrity };
    await fsp.writeFile(path.join(outputDir, `${prefix}-${version}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    return { archive, metadata };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

export async function collectRemoteDesktopPackages(inputDir, outputFile, options = {}) {
  const directory = path.resolve(inputDir);
  const entries = [];
  for (const name of (await fsp.readdir(directory)).sort()) {
    if (!name.endsWith(".metadata.json")) continue;
    const value = JSON.parse(await fsp.readFile(path.join(directory, name), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid remote desktop package metadata: ${name}`);
    if (value.package !== remoteDesktopPackageName(value.platform, value.arch)) throw new Error(`Remote desktop package name does not match its target: ${name}`);
    if (!exactVersion(value.version)) throw new Error(`Invalid remote desktop package version: ${name}`);
    if (typeof value.integrity !== "string" || !/^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity)) throw new Error(`Invalid remote desktop package integrity: ${name}`);
    entries.push({ version: value.version, platform: value.platform, arch: value.arch, package: value.package, integrity: value.integrity });
  }
  if (!entries.length) throw new Error("No remote desktop package metadata was found.");
  const versions = new Set(entries.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("Remote desktop package metadata mixes component versions.");
  const targets = new Set();
  for (const entry of entries) {
    const target = `${entry.platform}/${entry.arch}`;
    if (targets.has(target)) throw new Error(`Duplicate remote desktop package target: ${target}`);
    targets.add(target);
  }
  if (options.complete) {
    const missing = COMPLETE_TARGETS.filter((target) => !targets.has(target));
    if (missing.length) throw new Error(`Remote desktop package targets are incomplete; missing ${missing.join(", ")}.`);
  }
  entries.sort((left, right) => left.platform.localeCompare(right.platform) || left.arch.localeCompare(right.arch));
  const output = path.resolve(outputFile);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify({ packages: entries }, null, 2)}\n`);
  return { output, packages: entries };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "pack") {
    const result = await packRemoteDesktopPackage({
      version: args.version ?? process.env.TASK_HANDOFF_VERSION,
      platform: args.platform,
      arch: args.arch,
      binary: args.binary,
      output: args.output ?? path.join(root, "release", "remote-desktop-packages"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "metadata") {
    const result = await collectRemoteDesktopPackages(
      args.input ?? path.join(root, "release", "remote-desktop-packages"),
      args.output ?? path.join(root, "shared", "remote-desktop-packages.json"),
      { complete: args.complete === true },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error("Usage: remote-desktop-packages.mjs pack --version <v> --platform <linux|darwin> --arch <x64|arm64> --binary <path> --output <dir> | metadata [--complete] --input <dir> --output <file>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
