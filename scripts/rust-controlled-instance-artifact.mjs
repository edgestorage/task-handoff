#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "tar";
import {
  computePayloadSha256,
  defaultLauncherAbi,
  formatVersion,
  manifestName,
  payloadEntries,
  sha256File,
  verifyRuntimeArtifact,
} from "./runtime-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@task-handoff/controlled-instance";
const entrypoint = "dist/controlled-instance-cli.js";
const launcherAbi = defaultLauncherAbi;

function parseArguments(argv) {
  const values = { command: argv[0] ?? "build" };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

function assertVersion(version) {
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must be an exact semver version.");
  }
}

function parseArchitectures(value) {
  const result = [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (!result.length || result.some((arch) => !["x64", "arm64"].includes(arch))) {
    throw new Error("--archs must contain x64 and/or arm64.");
  }
  return result;
}

async function copyFile(source, destination, executable = false) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  if (executable) await fs.chmod(destination, 0o755);
}

async function copyDirectory(source, destination) {
  const stats = await fs.lstat(source).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(`Required runtime directory is missing: ${source}`);
  await fs.cp(source, destination, { recursive: true });
}

async function findPlugin(pluginPath) {
  const candidates = [
    pluginPath,
    path.join(root, "release", "npm", "controlled-instance", "dist", "opencode-story-plugin.mjs"),
    path.join(root, "dist", "runtime-packages", "controlled-instance", "opencode-story-plugin.mjs"),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  for (const candidate of candidates) {
    if (await fs.lstat(candidate).then((stats) => stats.isFile()).catch(() => false)) return candidate;
  }
  throw new Error("The approved OpenCode plugin adapter is missing; run the controlled-instance runtime build first or pass --plugin.");
}

async function assemblePackage(options) {
  assertVersion(options.version);
  const platform = options.platform ?? "linux";
  if (!["linux", "darwin", "win32", "universal"].includes(platform)) {
    throw new Error("--platform must be linux, darwin, win32, or universal.");
  }
  const architectures = parseArchitectures(options.archs ?? "x64,arm64");
  const packageDir = path.resolve(options["package-dir"] ?? path.join(root, "release", "rust-controlled-instance"));
  const binariesDir = path.resolve(options["binaries-dir"] ?? path.join(root, "release", "rust-controlled-instance-binaries"));
  const staticDir = path.resolve(options["static-dir"] ?? path.join(root, "packages", "controlled-instance-ui", "dist"));
  const outputDir = path.resolve(options.output ?? path.join(root, "release", "runtime-artifacts"));
  const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(packageDir, { recursive: true });
  await copyFile(path.join(root, "controlled-instance-rs", "packaging", "dist", "controlled-instance-cli.js"), path.join(packageDir, entrypoint), true);
  await copyFile(path.join(root, "controlled-instance-rs", "packaging", "bin", "task-handoff-controlled-instance"), path.join(packageDir, "bin", "task-handoff-controlled-instance"), true);
  await copyFile(await findPlugin(options.plugin), path.join(packageDir, "dist", "opencode-story-plugin.mjs"));
  await copyDirectory(staticDir, path.join(packageDir, "ui"));

  const binaries = [];
  for (const platformName of platform === "universal" ? ["linux", "darwin", "win32"] : [platform]) {
    for (const arch of architectures) {
      if (platformName === "win32" && arch !== "x64") continue;
      const fileName = `controlled-instance-${platformName}-${arch}${platformName === "win32" ? ".exe" : ""}`;
      const source = path.join(binariesDir, fileName);
      const stats = await fs.lstat(source).catch(() => undefined);
      if (!stats?.isFile()) throw new Error(`Rust runtime binary is missing: ${path.relative(root, source)}`);
      await copyFile(source, path.join(packageDir, "bin", fileName), true);
      binaries.push({ platform: platformName, arch, path: `bin/${fileName}`, size: stats.size });
    }
  }

  for (const legal of ["LICENSE", "NOTICE"]) {
    await copyFile(path.join(root, legal), path.join(packageDir, legal));
  }
  await fs.writeFile(path.join(packageDir, "README.md"), "# @task-handoff/controlled-instance\n\nRust controlled instance runtime. The launcher and OpenCode plugin are compatibility adapters; product behavior lives in the Rust binary.\n", "utf8");
  await fs.writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
    name: packageName,
    version: options.version,
    description: "Rust TaskHandoff controlled instance runtime.",
    repository: rootPackage.repository,
    license: rootPackage.license,
    homepage: rootPackage.homepage,
    bugs: rootPackage.bugs,
    keywords: ["task-handoff", "controlled-instance", "sandbox", "runtime", "ai-agents", "agent-orchestration"],
    type: "commonjs",
    main: entrypoint,
    bin: { "task-handoff-controlled-instance": "bin/task-handoff-controlled-instance" },
    files: ["bin", "dist", "ui", "README.md", "LICENSE", "NOTICE"],
    engines: rootPackage.engines,
    publishConfig: { access: "public" },
    taskHandoffRuntime: { implementation: "rust", binaries },
  }, null, 2)}\n`, "utf8");

  const manifest = {
    packageName,
    version: options.version,
    platform,
    arch: architectures.length === 2 ? "universal" : architectures[0],
    formatVersion,
    launcherAbi,
    entrypoint,
    sha256: await computePayloadSha256(packageDir),
  };
  await fs.writeFile(path.join(packageDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.mkdir(outputDir, { recursive: true });
  const stem = `controlled-instance-runtime-${options.version}-${platform}-${manifest.arch}`;
  const temporaryArchive = path.join(outputDir, `.${stem}-${randomUUID()}.tar.gz`);
  const archivePath = path.join(outputDir, `${stem}.tar.gz`);
  const entries = [manifestName, ...(await payloadEntries(packageDir)).map((item) => item.relativePath)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  await create({ cwd: packageDir, file: temporaryArchive, gzip: true, portable: true, noMtime: true }, entries);
  const archiveSha256 = await sha256File(temporaryArchive);
  await fs.rename(temporaryArchive, archivePath);
  await fs.writeFile(path.join(outputDir, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, `${stem}.tar.gz.sha256`), `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");
  await verifyRuntimeArtifact({ archivePath, archiveSha256, expected: { version: options.version, platform, arch: manifest.arch } });
  return { archivePath, archiveSha256, manifest, packageDir };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== "build") throw new Error(`Unknown command: ${args.command}`);
  const result = await assemblePackage({ ...args, version: args.version ?? process.env.TASK_HANDOFF_VERSION });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
