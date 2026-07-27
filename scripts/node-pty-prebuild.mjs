#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const supportedTargets = new Set([
  "linux-x64",
  "linux-arm64",
]);
const requiredPayload = ["pty.node"];

function parseArguments(argv) {
  if (argv[1] === "--") argv = [argv[0], ...argv.slice(2)];
  const values = { command: argv[0] ?? "build" };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

function assertSupportedTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!supportedTargets.has(target)) throw new Error(`Unsupported node-pty prebuild target: ${target}.`);
}

export function assertNativeTarget(platform, arch) {
  assertSupportedTarget(platform, arch);
  const target = `${platform}-${arch}`;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`node-pty must be prebuilt natively on ${target}; current builder is ${process.platform}-${process.arch}.`);
  }
}

async function assertRequiredPayload(targetDir) {
  for (const name of requiredPayload) {
    const stats = await fs.lstat(path.join(targetDir, name)).catch(() => undefined);
    if (!stats?.isFile()) throw new Error(`node-pty prebuild is missing ${name} in ${targetDir}.`);
  }
}

export async function collectNodePtyPrebuild({ output, platform = process.platform, arch = process.arch, packageDir }) {
  assertSupportedTarget(platform, arch);
  const sourcePackage = path.resolve(packageDir ?? path.dirname(require.resolve("node-pty/package.json")));
  const packagedPrebuild = path.join(sourcePackage, "prebuilds", `${platform}-${arch}`);
  const builtRelease = path.join(sourcePackage, "build", "Release");
  const packagedSource = await fs.lstat(packagedPrebuild).then((stats) => stats.isDirectory() ? packagedPrebuild : undefined).catch(() => undefined);
  if (!packagedSource) assertNativeTarget(platform, arch);
  const source = packagedSource
    ?? await fs.lstat(builtRelease).then((stats) => stats.isDirectory() ? builtRelease : undefined).catch(() => undefined);
  if (!source) throw new Error(`node-pty has no native output for ${platform}-${arch}; run its native build first.`);

  const targetDir = path.resolve(output, `${platform}-${arch}`);
  await fs.rm(targetDir, { recursive: true, force: true });
  await assertRequiredPayload(source);
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of requiredPayload) await fs.copyFile(path.join(source, name), path.join(targetDir, name));
  await assertRequiredPayload(targetDir);
  return targetDir;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== "build") throw new Error(`Unknown command: ${args.command}`);
  const targetDir = await collectNodePtyPrebuild({
    output: args.output,
    platform: args.platform,
    arch: args.arch,
    packageDir: args["package-dir"],
  });
  console.log(targetDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
