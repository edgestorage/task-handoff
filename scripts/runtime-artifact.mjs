#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create, extract } from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export const manifestName = "runtime-manifest.json";
export const formatVersion = 1;
export const defaultLauncherAbi = 1;
const packageName = "@task-handoff/controlled-instance";
const entrypoint = "dist/controlled-instance-cli.js";
export const runtimePlatform = "linux";
export const universalArch = "universal";
export const requiredNodePtyTargets = ["linux-x64", "linux-arm64"];

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

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function payloadEntries(rootDir, relativeDir = "") {
  const result = [];
  for (const entry of await fs.readdir(path.join(rootDir, relativeDir), { withFileTypes: true })) {
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (!relativeDir && relativePath === manifestName) continue;
    const absolutePath = path.join(rootDir, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      result.push(...await payloadEntries(rootDir, relativePath));
    } else if (entry.isFile()) {
      const stats = await fs.lstat(absolutePath);
      result.push({ absolutePath, relativePath, kind: "file", size: stats.size });
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      const resolved = path.resolve(path.dirname(absolutePath), target);
      const relativeTarget = path.relative(path.resolve(rootDir), resolved);
      if (path.isAbsolute(target) || !relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        throw new Error(`Runtime payload symlink escapes the artifact: ${relativePath}`);
      }
      if (!await fs.lstat(resolved).catch(() => undefined)) throw new Error(`Runtime payload symlink is broken: ${relativePath}`);
      result.push({ absolutePath, relativePath, kind: "symlink", target, size: Buffer.byteLength(target) });
    } else {
      throw new Error(`Runtime payload contains unsupported entry: ${relativePath}`);
    }
  }
  return result;
}

export async function copyNodePtyRuntime(destination, sourcePackage = path.dirname(require.resolve("node-pty/package.json")), prebuildsDir) {
  const targetPackage = path.join(destination, "node_modules", "node-pty");
  await fs.mkdir(targetPackage, { recursive: true });
  for (const name of ["LICENSE", "package.json", "lib"]) {
    await fs.cp(path.join(sourcePackage, name), path.join(targetPackage, name), { recursive: true });
  }
  const sourcePrebuilds = path.resolve(prebuildsDir ?? path.join(sourcePackage, "prebuilds"));
  for (const target of requiredNodePtyTargets) {
    const source = path.join(sourcePrebuilds, target);
    const stats = await fs.lstat(source).catch(() => undefined);
    if (!stats?.isDirectory()) throw new Error(`Linux runtime is missing node-pty prebuild ${target}.`);
    const nativeModule = path.join(source, "pty.node");
    if (!await fs.lstat(nativeModule).then((item) => item.isFile()).catch(() => false)) {
      throw new Error(`Linux runtime is missing node-pty prebuild ${target}/pty.node.`);
    }
    const targetDir = path.join(targetPackage, "prebuilds", target);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(nativeModule, path.join(targetDir, "pty.node"));
  }
}

export async function computePayloadSha256(rootDir) {
  const entries = (await payloadEntries(rootDir)).sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind === "file" ? "F" : "L", "ascii");
    hash.update(Buffer.from(entry.relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(entry.size), "ascii"));
    hash.update(Buffer.from([0]));
    if (entry.kind === "file") {
      for await (const chunk of createReadStream(entry.absolutePath)) hash.update(chunk);
    } else {
      hash.update(Buffer.from(entry.target, "utf8"));
    }
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertManifest(manifest, expected = {}) {
  const requiredStrings = ["packageName", "version", "platform", "arch", "entrypoint", "sha256"];
  for (const key of requiredStrings) if (typeof manifest[key] !== "string" || !manifest[key]) throw new Error(`Manifest ${key} is required.`);
  if (manifest.packageName !== packageName) throw new Error(`Manifest packageName must be ${packageName}.`);
  if (manifest.formatVersion !== formatVersion) throw new Error(`Unsupported manifest formatVersion: ${manifest.formatVersion}`);
  if (!Number.isInteger(manifest.launcherAbi) || manifest.launcherAbi < 1) throw new Error("Manifest launcherAbi must be a positive integer.");
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Manifest sha256 is invalid.");
  for (const key of ["version", "platform", "arch"]) {
    if (expected[key] && manifest[key] !== expected[key]) throw new Error(`Manifest ${key} mismatch: expected ${expected[key]}, got ${manifest[key]}.`);
  }
}

export async function verifyRuntimeArtifact({ archivePath, archiveSha256, expected = {} }) {
  if (archiveSha256 && await sha256File(archivePath) !== archiveSha256) throw new Error("Runtime archive SHA-256 mismatch.");
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "task-handoff-runtime-verify-"));
  try {
    await extract({ file: archivePath, cwd: destination, strict: true, preservePaths: false });
    const manifest = JSON.parse(await fs.readFile(path.join(destination, manifestName), "utf8"));
    assertManifest(manifest, expected);
    const stats = await fs.lstat(path.join(destination, ...manifest.entrypoint.split("/"))).catch(() => undefined);
    if (!stats?.isFile()) throw new Error(`Runtime entrypoint is missing: ${manifest.entrypoint}`);
    const payloadSha256 = await computePayloadSha256(destination);
    if (payloadSha256 !== manifest.sha256) throw new Error(`Runtime payload SHA-256 mismatch: expected ${manifest.sha256}, got ${payloadSha256}.`);
    return manifest;
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
}

export async function buildRuntimeArtifact(options) {
  const version = options.version;
  const platform = runtimePlatform;
  const arch = universalArch;
  const launcherAbi = Number(options.launcherAbi ?? defaultLauncherAbi);
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("--version must be an exact semver version.");
  if (!Number.isInteger(launcherAbi) || launcherAbi < 1) throw new Error("--launcher-abi must be a positive integer.");

  const builtPackage = path.resolve(options.packageDir ?? path.join(root, "release", "npm", "controlled-instance"));
  const packageManifest = JSON.parse(await fs.readFile(path.join(builtPackage, "package.json"), "utf8"));
  if (packageManifest.name !== packageName || packageManifest.version !== version) {
    throw new Error(`Prepared controlled-instance package must be ${packageName}@${version}.`);
  }
  if (!await fs.lstat(path.join(builtPackage, entrypoint)).then((stats) => stats.isFile()).catch(() => false)) {
    throw new Error(`Prepared controlled-instance package is missing ${entrypoint}.`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-handoff-runtime-build-"));
  const payloadDir = path.join(workDir, "payload");
  const outputDir = path.resolve(options.output ?? path.join(root, "release", "runtime-artifacts"));
  try {
    await fs.cp(builtPackage, payloadDir, { recursive: true });
    await copyNodePtyRuntime(payloadDir, undefined, options.prebuildsDir);
    const manifest = {
      packageName,
      version,
      platform,
      arch,
      formatVersion,
      launcherAbi,
      entrypoint,
      sha256: await computePayloadSha256(payloadDir),
    };
    await fs.writeFile(path.join(payloadDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.mkdir(outputDir, { recursive: true });
    const stem = `controlled-instance-runtime-${version}-linux-universal`;
    const temporaryArchive = path.join(outputDir, `.${stem}-${randomUUID()}.tar.gz`);
    const archivePath = path.join(outputDir, `${stem}.tar.gz`);
    const archiveEntries = [manifestName, ...(await payloadEntries(payloadDir)).map((item) => item.relativePath)].sort(compareUtf8);
    await create({ cwd: payloadDir, file: temporaryArchive, gzip: true, portable: true, noMtime: true }, archiveEntries);
    const archiveSha256 = await sha256File(temporaryArchive);
    await fs.rename(temporaryArchive, archivePath);
    await fs.writeFile(path.join(outputDir, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(outputDir, `${stem}.tar.gz.sha256`), `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");
    await verifyRuntimeArtifact({ archivePath, archiveSha256, expected: { version, platform, arch } });
    return { archivePath, archiveSha256, manifest };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "build") {
    const result = await buildRuntimeArtifact({
      version: args.version ?? process.env.TASK_HANDOFF_VERSION,
      launcherAbi: args["launcher-abi"],
      output: args.output,
      packageDir: args["package-dir"],
      prebuildsDir: args["prebuilds-dir"],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "verify") {
    const archivePath = path.resolve(args.archive ?? "");
    const checksumText = args.sha256 ? await fs.readFile(path.resolve(args.sha256), "utf8") : undefined;
    const archiveSha256 = checksumText?.trim().split(/\s+/)[0];
    const manifest = await verifyRuntimeArtifact({
      archivePath,
      archiveSha256,
      expected: { version: args.version, platform: args.platform, arch: args.arch },
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
