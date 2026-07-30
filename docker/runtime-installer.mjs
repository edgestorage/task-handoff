#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LAUNCHER_ABI = 1;
const PACKAGE_NAME = "@task-handoff/controlled-instance";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  if (!["install", "verify-active"].includes(argv[0])) fail("Usage: task-handoff-runtime <install|verify-active> [...]");
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("Invalid runtime installer arguments.");
    result[key.slice(2)] = value;
  }
  return result;
}

function listPayloadFiles(root, relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (child === "runtime-manifest.json") continue;
    if (!entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile()) fail(`Runtime artifact contains an unsupported entry: ${child}`);
    if (entry.isDirectory()) files.push(...listPayloadFiles(root, child));
    else files.push({ relative: child, type: entry.isSymbolicLink() ? "L" : "F" });
  }
  return files;
}

function payloadSha256(root) {
  const hash = crypto.createHash("sha256");
  const resolvedRoot = fs.realpathSync(root);
  const files = listPayloadFiles(root).sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
  for (const item of files) {
    const absolute = path.join(root, item.relative);
    const contents = item.type === "L" ? Buffer.from(fs.readlinkSync(absolute), "utf8") : fs.readFileSync(absolute);
    if (item.type === "L") {
      const resolved = fs.realpathSync(absolute);
      if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail(`Runtime artifact symlink escapes its root: ${item.relative}`);
    }
    hash.update(Buffer.from(item.type, "ascii"));
    hash.update(Buffer.from(item.relative, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(contents.byteLength), "ascii"));
    hash.update(Buffer.from([0]));
    hash.update(contents);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function validateVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(value);
}

function lockReleaseTree(root) {
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  const group = typeof process.getgid === "function" ? process.getgid() : 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) lockReleaseTree(absolute);
    fs.lchownSync(absolute, owner, group);
    if (!entry.isSymbolicLink()) {
      const mode = fs.lstatSync(absolute).mode & 0o777;
      fs.chmodSync(absolute, entry.isDirectory() || (mode & 0o111) !== 0 ? 0o755 : 0o644);
    }
  }
  fs.chownSync(root, owner, group);
  fs.chmodSync(root, 0o755);
}

const args = parseArgs(process.argv.slice(2));
const runtimeRoot = process.env.TASK_HANDOFF_INSTANCE_RUNTIME_ROOT || "/opt/task-handoff/instance-runtime";
function validateRelease(release, expectedVersion) {
  const manifest = JSON.parse(fs.readFileSync(path.join(release, "runtime-manifest.json"), "utf8"));
  if (manifest.packageName !== PACKAGE_NAME || (expectedVersion && manifest.version !== expectedVersion) || manifest.formatVersion !== 1 || manifest.launcherAbi !== LAUNCHER_ABI) fail("Runtime release manifest is invalid.");
  const compatible = (manifest.platform === "universal" || manifest.platform === process.platform)
    && (manifest.arch === "universal" || manifest.arch === process.arch);
  if (!compatible || payloadSha256(release) !== manifest.sha256) fail("Runtime release is incompatible or corrupt.");
  const entrypoint = path.resolve(release, manifest.entrypoint);
  if (!entrypoint.startsWith(`${release}${path.sep}`) || !fs.statSync(entrypoint).isFile()) fail("Runtime release entrypoint is invalid.");
  return manifest;
}
if (args.command === "verify-active") {
  const release = fs.realpathSync(path.join(runtimeRoot, "current"));
  const manifest = validateRelease(release);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  process.exit(0);
}
const expected = {
  version: args.version,
  sha256: args.sha256,
  platform: args.platform,
  arch: args.arch,
  launcherAbi: Number(args["launcher-abi"]),
};
if (!args.artifact || !validateVersion(expected.version) || !/^[a-f0-9]{64}$/.test(expected.sha256 || "")) fail("Invalid runtime artifact identity.");
if (expected.launcherAbi !== LAUNCHER_ABI) fail(`Unsupported launcher ABI: ${expected.launcherAbi}`);

const stagingRoot = path.join(runtimeRoot, "staging");
const releasesRoot = path.join(runtimeRoot, "releases");
const releaseKey = `${expected.version}-${expected.sha256}`;
fs.mkdirSync(stagingRoot, { recursive: true });
fs.mkdirSync(releasesRoot, { recursive: true });
const staging = fs.mkdtempSync(path.join(stagingRoot, `${expected.version}-`));
let preserveStaging = false;

try {
  // A production runtime contains thousands of dependency files, so its tar
  // listing legitimately exceeds spawnSync's small default output buffer.
  // The archive itself is already pinned by the release identity; keep a
  // bounded but production-sized buffer while validating every entry type.
  const listing = spawnSync("tar", ["-tvzf", args.artifact], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (listing.status !== 0) fail(listing.stderr || "Could not inspect runtime artifact.");
  for (const line of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!["-", "d", "l"].includes(line[0])) fail("Runtime artifact contains a hard link or special file.");
  }
  const unpacked = spawnSync("tar", ["-xzf", args.artifact, "--no-same-owner", "--no-same-permissions", "-C", staging], { encoding: "utf8" });
  if (unpacked.status !== 0) fail(unpacked.stderr || "Could not unpack runtime artifact.");
  const manifestPath = path.join(staging, "runtime-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestKeys = ["arch", "entrypoint", "formatVersion", "launcherAbi", "packageName", "platform", "sha256", "version"];
  const exactIdentity = Object.keys(manifest).sort().join("\0") === manifestKeys.join("\0")
    && manifest.packageName === PACKAGE_NAME
    && manifest.version === expected.version
    && manifest.platform === expected.platform
    && manifest.arch === expected.arch
    && manifest.formatVersion === 1
    && manifest.launcherAbi === expected.launcherAbi
    && manifest.sha256 === expected.sha256
    && typeof manifest.entrypoint === "string";
  if (!exactIdentity) fail("Runtime artifact manifest does not match the requested identity.");
  const compatible = (manifest.platform === "universal" || manifest.platform === process.platform)
    && (manifest.arch === "universal" || manifest.arch === process.arch);
  if (!compatible) fail(`Runtime artifact is incompatible with ${process.platform}/${process.arch}.`);
  const entrypoint = path.resolve(staging, manifest.entrypoint);
  if (!entrypoint.startsWith(`${staging}${path.sep}`) || !fs.statSync(entrypoint).isFile()) fail("Runtime artifact entrypoint is invalid.");
  if (payloadSha256(staging) !== expected.sha256) fail("Runtime artifact payload SHA-256 is invalid.");

  const release = path.join(releasesRoot, releaseKey);
  if (fs.existsSync(release)) {
    const existingManifest = JSON.parse(fs.readFileSync(path.join(release, "runtime-manifest.json"), "utf8"));
    const existingIdentityMatches = existingManifest.packageName === PACKAGE_NAME
      && existingManifest.version === expected.version
      && existingManifest.platform === expected.platform
      && existingManifest.arch === expected.arch
      && existingManifest.formatVersion === 1
      && existingManifest.launcherAbi === expected.launcherAbi
      && existingManifest.sha256 === expected.sha256
      && typeof existingManifest.entrypoint === "string";
    if (!existingIdentityMatches || payloadSha256(release) !== expected.sha256) fail(`Existing release ${releaseKey} is invalid.`);
  } else {
    fs.renameSync(staging, release);
    preserveStaging = true;
  }
  lockReleaseTree(release);

  const next = path.join(runtimeRoot, `.current-${process.pid}-${Date.now()}`);
  fs.symlinkSync(path.relative(runtimeRoot, release), next);
  fs.renameSync(next, path.join(runtimeRoot, "current"));
  process.stdout.write(`${JSON.stringify({ version: expected.version, sha256: expected.sha256, release })}\n`);
} finally {
  if (!preserveStaging) fs.rmSync(staging, { recursive: true, force: true });
}
