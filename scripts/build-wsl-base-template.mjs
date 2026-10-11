#!/usr/bin/env node
/**
 * Build the versioned WSL base template (openspec change add-wsl-runtime, 10.1 / 4.5).
 *
 * The tool baseline is derived from the task-handoff-images base layer: this script does not
 * invent tooling, it takes that rootfs, enables systemd for the WSL boot model, records the
 * observed tool versions for diagnostics, and packages a deterministic `wsl-base-<version>-<arch>.tar.gz`
 * plus the manifest consumed by `packages/control-plane/src/node-agent/runtimes/wsl-provisioning.ts`.
 *
 * Output contract (must match WslBaseTemplateManifestSchema):
 *   { id: "wsl-base", version, platform: "linux", arch, formatVersion: 1, sha256, sizeBytes, createdAt, tools }
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { create } from "tar";

const BASE_TEMPLATE_ID = "wsl-base";
const FORMAT_VERSION = 1;
const EXCLUDED_ROOTS = ["proc", "sys", "dev", "run", "tmp"];

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

function hostArchitecture() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

async function pathExists(target) {
  return fs.lstat(target).then(() => true, () => false);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readToolVersion(rootfs, tool, versionArgs) {
  // The rootfs is not executable on the build host; read declared versions from the packaged
  // metadata when present, otherwise record the executable's presence only. Diagnostics never
  // drive behaviour, so a missing version is not an error.
  for (const candidate of [`usr/local/bin/${tool}`, `usr/bin/${tool}`, `bin/${tool}`, `usr/lib/node_modules`]) {
    if (candidate.endsWith(`${tool}`) && await pathExists(path.join(rootfs, candidate))) return "present";
  }
  const metadata = path.join(rootfs, "etc", "task-handoff", "tool-versions.json");
  if (await pathExists(metadata)) {
    try {
      const parsed = JSON.parse(await fs.readFile(metadata, "utf8"));
      if (typeof parsed?.[tool] === "string") return parsed[tool];
    } catch {
      // Ignore malformed metadata.
    }
  }
  void versionArgs;
  return undefined;
}

async function ensureSystemdBoot(rootfs) {
  const wslConf = path.join(rootfs, "etc", "wsl.conf");
  let existing = "";
  if (await pathExists(wslConf)) existing = await fs.readFile(wslConf, "utf8");
  if (/^\s*systemd\s*=\s*true\s*$/m.test(existing)) return;
  const addition = `${existing && !existing.endsWith("\n") ? "\n" : ""}[boot]\nsystemd=true\n`;
  await fs.mkdir(path.dirname(wslConf), { recursive: true });
  await fs.writeFile(wslConf, `${existing}${addition}`, "utf8");
}

// `[boot] systemd=true` only works when the rootfs actually carries an init: the Docker base layer
// (`node:*-bookworm-slim`) has none, so `systemctl daemon-reload` would fail with exit code 127
// inside the distro. Verify the boot model and the CLI the lifecycle calls are both present.
const SYSTEMD_INIT_CANDIDATES = ["lib/systemd/systemd", "usr/lib/systemd/systemd", "sbin/init"];
const SYSTEMDCTL_CANDIDATES = ["usr/bin/systemctl", "bin/systemctl"];

async function anyPathExists(rootfs, candidates) {
  for (const candidate of candidates) {
    if (await pathExists(path.join(rootfs, candidate))) return true;
  }
  return false;
}

async function assertSystemdBootable(rootfs) {
  const missing = [];
  if (!await anyPathExists(rootfs, SYSTEMD_INIT_CANDIDATES)) missing.push("a systemd init (/lib/systemd/systemd)");
  if (!await anyPathExists(rootfs, SYSTEMDCTL_CANDIDATES)) missing.push("systemctl (/usr/bin/systemctl)");
  if (missing.length) {
    throw new Error(
      `WSL base template rootfs is missing ${missing.join(" and ")}. The task-handoff-images base layer ships no init, `
      + "so the template build must install `systemd` + `systemd-sysv` (and `dbus`) into the exported rootfs before packaging.",
    );
  }
}

function tarFilter(relativePath) {
  const [root] = relativePath.split("/");
  return !EXCLUDED_ROOTS.includes(root);
}

export async function buildWslBaseTemplate({ rootfs, version, arch, outputDir, now = () => new Date() }) {
  if (!rootfs) throw new Error("--rootfs is required: point it at the task-handoff-images base layer rootfs.");
  const resolvedRootfs = path.resolve(rootfs);
  const stats = await fs.stat(resolvedRootfs).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`WSL base template rootfs ${resolvedRootfs} is not a directory.`);
  if (!version) throw new Error("--version is required.");
  const targetArch = arch || hostArchitecture();
  const outDir = path.resolve(outputDir);
  await fs.mkdir(outDir, { recursive: true });
  await ensureSystemdBoot(resolvedRootfs);
  await assertSystemdBootable(resolvedRootfs);

  const stem = `${BASE_TEMPLATE_ID}-${version}-${targetArch}`;
  const archivePath = path.join(outDir, `${stem}.tar.gz`);
  await fs.rm(archivePath, { force: true });
  await create({ gzip: true, file: archivePath, cwd: resolvedRootfs, portable: true, filter: tarFilter }, ["."]);

  const tools = {};
  for (const tool of ["node", "python3", "git"]) {
    const value = await readToolVersion(resolvedRootfs, tool, ["--version"]);
    if (value) tools[tool] = value;
  }

  const manifest = {
    id: BASE_TEMPLATE_ID,
    version,
    platform: "linux",
    arch: targetArch,
    formatVersion: FORMAT_VERSION,
    sha256: await sha256File(archivePath),
    sizeBytes: (await fs.stat(archivePath)).size,
    createdAt: now().toISOString(),
    ...(Object.keys(tools).length ? { tools } : {}),
  };
  const manifestPath = path.join(outDir, `${stem}.manifest.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { archivePath, manifestPath, manifest };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== "build") throw new Error(`Unsupported command: ${args.command}`);
  const version = args.version || process.env.TASK_HANDOFF_WSL_BASE_TEMPLATE_VERSION;
  const result = await buildWslBaseTemplate({
    rootfs: args.rootfs || process.env.TASK_HANDOFF_WSL_BASE_TEMPLATE_ROOTFS,
    version,
    arch: args.arch,
    outputDir: args.out || path.resolve("release", "runtime-artifacts", "wsl-base"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
