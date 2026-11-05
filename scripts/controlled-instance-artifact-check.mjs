import fs from "node:fs";
import path from "node:path";
import { list as listTar } from "tar";

const controlPlaneDatabaseDependencies = ["drizzle-orm", "pg"];
const controlPlaneDatabasePayloadPatterns = [
  /require\(["']pg["']\)/,
  /require\(["']node:sqlite["']\)/,
  /cp_migration_ledger/,
];

function assertNoControlPlaneDatabasePayload(label, manifest, outputs) {
  for (const dependency of controlPlaneDatabaseDependencies) {
    if (manifest.dependencies?.[dependency] || manifest.optionalDependencies?.[dependency]) {
      throw new Error(`${label} must not depend on Control Plane database package ${dependency}.`);
    }
  }
  for (const [filename, content] of outputs) {
    if (controlPlaneDatabasePayloadPatterns.some((pattern) => pattern.test(content))) {
      throw new Error(`${label} contains Control Plane database code in ${filename}.`);
    }
  }
}

function assertSafeArchiveEntry(entry) {
  const normalized = path.posix.normalize(entry.path.replace(/^\.\//, ""));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`controlled-instance runtime artifact contains an escaping path: ${entry.path}`);
  }
  if (!["File", "OldFile", "Directory", "SymbolicLink"].includes(entry.type)) {
    throw new Error(`controlled-instance runtime artifact contains unsupported entry type ${entry.type}: ${entry.path}`);
  }
}

async function inspectArchive(archivePath) {
  let packageManifest;
  let runtimeManifest;
  const outputs = [];
  const nativeAddons = [];
  const entries = [];
  const reads = [];
  await listTar({
    file: archivePath,
    onReadEntry(entry) {
      assertSafeArchiveEntry(entry);
      entries.push({ path: entry.path, mode: entry.mode, type: entry.type });
      if (entry.path.endsWith(".node")) nativeAddons.push(entry.path);
      if (!["package.json", "runtime-manifest.json", "bin/task-handoff-controlled-instance"].includes(entry.path) && !/^dist\/.*\.(?:js|mjs)$/.test(entry.path)) {
        entry.resume();
        return;
      }
      reads.push(new Promise((resolve, reject) => {
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("error", reject);
        entry.on("end", () => {
          const content = Buffer.concat(chunks).toString("utf8");
          if (entry.path === "package.json") packageManifest = JSON.parse(content);
          else if (entry.path === "runtime-manifest.json") runtimeManifest = JSON.parse(content);
          else outputs.push([entry.path, content]);
          resolve();
        });
      }));
    },
  });
  await Promise.all(reads);
  return { packageManifest, runtimeManifest, outputs, nativeAddons, entries };
}

function assertRustPayload({ packageManifest, runtimeManifest, outputs, nativeAddons, entries }) {
  const label = "Rust controlled-instance runtime artifact";
  if (packageManifest.name !== "@task-handoff/controlled-instance" || typeof packageManifest.version !== "string") {
    throw new Error(`${label} package identity is invalid.`);
  }
  if (packageManifest.bin?.["task-handoff-controlled-instance"] !== "bin/task-handoff-controlled-instance"
    || packageManifest.main !== "dist/controlled-instance-cli.js") {
    throw new Error(`${label} must preserve the launcher ABI entrypoint.`);
  }
  if (runtimeManifest.packageName !== packageManifest.name || runtimeManifest.version !== packageManifest.version) {
    throw new Error(`${label} manifest does not match package.json.`);
  }
  if (entries.some((entry) => entry.path === "node_modules" || entry.path.startsWith("node_modules/"))) {
    throw new Error(`${label} must not contain node_modules.`);
  }
  if (entries.some((entry) => entry.path === "src" || entry.path.startsWith("src/"))) {
    throw new Error(`${label} must not contain source files.`);
  }
  if (nativeAddons.length) {
    throw new Error(`${label} must not contain native Node addons: ${nativeAddons.join(", ")}.`);
  }
  const unapprovedScripts = entries
    .map((entry) => entry.path)
    .filter((entryPath) => /\.(?:c?js|mjs)$/.test(entryPath))
    .filter((entryPath) => !entryPath.startsWith("ui/"))
    .filter((entryPath) => !["bin/task-handoff-controlled-instance", "dist/controlled-instance-cli.js", "dist/opencode-story-plugin.mjs"].includes(entryPath));
  if (unapprovedScripts.length) {
    throw new Error(`${label} contains unapproved JavaScript entries: ${unapprovedScripts.join(", ")}.`);
  }
  const allowedScripts = new Set(["bin/task-handoff-controlled-instance", "dist/controlled-instance-cli.js", "dist/opencode-story-plugin.mjs"]);
  for (const [scriptPath, content] of outputs) {
    if (!allowedScripts.has(scriptPath)) {
      throw new Error(`${label} contains an unapproved JavaScript entry: ${scriptPath}.`);
    }
    const workspaceImport = content.match(/(?:require\(|from\s+|import\s*)["'](?:@task-handoff\/|\.\.\/(?:apps|packages|scripts)\/)/);
    if (workspaceImport) {
      throw new Error(`${label} adapter ${scriptPath} imports controlled-instance business code: ${workspaceImport[0]}.`);
    }
  }
  if (outputs.length !== allowedScripts.size) {
    throw new Error(`${label} must contain exactly the launcher and OpenCode plugin adapters.`);
  }
  const launcher = outputs.find(([scriptPath]) => scriptPath === "dist/controlled-instance-cli.js")?.[1] ?? "";
  if (!launcher.includes("controlled-instance-${process.platform}-${process.arch}")) {
    throw new Error(`${label} launcher does not select the platform Rust binary.`);
  }
  const launcherEntry = entries.find((entry) => entry.path === "dist/controlled-instance-cli.js");
  if (!launcherEntry || launcherEntry.type !== "File" || (launcherEntry.mode & 0o111) === 0) {
    throw new Error(`${label} launcher is missing or not executable.`);
  }
  const binLauncherEntry = entries.find((entry) => entry.path === "bin/task-handoff-controlled-instance");
  if (!binLauncherEntry || binLauncherEntry.type !== "File" || (binLauncherEntry.mode & 0o111) === 0) {
    throw new Error(`${label} launcher ABI bin entrypoint is missing or not executable.`);
  }
  const declaredBinaries = packageManifest.taskHandoffRuntime.binaries;
  if (!Array.isArray(declaredBinaries) || !declaredBinaries.length) {
    throw new Error(`${label} must declare its Rust binaries.`);
  }
  for (const binary of declaredBinaries) {
    if (typeof binary?.path !== "string" || !/^bin\/[A-Za-z0-9._-]+$/.test(binary.path)) {
      throw new Error(`${label} has an invalid Rust binary path.`);
    }
    const entry = entries.find((candidate) => candidate.path === binary.path);
    if (!entry || entry.type !== "File" || (entry.mode & 0o111) === 0) {
      throw new Error(`${label} Rust binary is missing or not executable: ${binary.path}.`);
    }
  }
  if (!entries.some((entry) => entry.path === "ui/index.html")) {
    throw new Error(`${label} is missing the frozen Web UI.`);
  }
  assertNoControlPlaneDatabasePayload(label, packageManifest, outputs);
}

export async function checkControlledInstanceArtifact(artifactDir, { version, implementation } = {}) {
  const archiveName = fs.readdirSync(artifactDir).find((entry) => version
    ? entry === `controlled-instance-runtime-${version}-linux-universal.tar.gz`
    : entry.endsWith(".tar.gz"));
  if (!archiveName) throw new Error("controlled-instance runtime artifact is missing.");
  const inspected = await inspectArchive(path.join(artifactDir, archiveName));
  const { packageManifest, runtimeManifest, outputs, nativeAddons } = inspected;
  if (!packageManifest) throw new Error("controlled-instance runtime artifact is missing package.json.");
  if (!runtimeManifest) throw new Error("controlled-instance runtime artifact is missing runtime-manifest.json.");
  const actualImplementation = packageManifest.taskHandoffRuntime?.implementation ?? "node";
  if (implementation && actualImplementation !== implementation) {
    throw new Error(`Controlled-instance artifact implementation is ${actualImplementation}; expected ${implementation}.`);
  }
  if (packageManifest.taskHandoffRuntime?.implementation === "rust") {
    assertRustPayload(inspected);
    return { implementation: "rust", manifest: runtimeManifest };
  }
  assertNoControlPlaneDatabasePayload("controlled-instance runtime artifact", packageManifest, outputs);
  const nativeRuntimeBinaries = inspected.entries.filter((entry) => entry.path.startsWith("bin/controlled-instance-"));
  if (nativeRuntimeBinaries.length) {
    throw new Error("Node controlled-instance runtime artifact must not contain Rust runtime binaries.");
  }
  const unexpectedAddons = nativeAddons.filter((entry) => !entry.split("/").includes("node-pty"));
  if (unexpectedAddons.length) {
    throw new Error(`controlled-instance runtime artifact contains unexpected native addons: ${unexpectedAddons.join(", ")}.`);
  }
  return { implementation: "node", manifest: runtimeManifest };
}
