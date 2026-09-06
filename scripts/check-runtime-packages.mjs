#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Argument, Command } from "commander";
import { list as listTar } from "tar";
import { runtimePackages } from "../runtime-packages.config.mjs";
import { installedDependencyManifests, materializeInstalledDependencies } from "./runtime-dependency-versions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const program = new Command()
  .name("check-runtime-packages")
  .description("Validate assembled TaskHandoff runtime npm packages.")
  .addArgument(new Argument("[target]", "check one runtime package").choices(Object.keys(runtimePackages)))
  .parse(process.argv);
const [requestedTarget] = program.processedArgs;
const selected = requestedTarget
  ? Object.entries(runtimePackages).filter(([name]) => name === requestedTarget)
  : Object.entries(runtimePackages);
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

function nativeAddonPaths(directory, relative = "") {
  const addons = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) addons.push(...nativeAddonPaths(directory, entryRelative));
    else if (entry.isFile() && entry.name.endsWith(".node")) addons.push(entryRelative);
  }
  return addons;
}

function assertNodeAgentDatabaseBoundary(packageDir, manifest, outputs) {
  if (!manifest.dependencies?.["drizzle-orm"] && !manifest.optionalDependencies?.["drizzle-orm"]) {
    throw new Error("node-agent runtime package must depend on drizzle-orm.");
  }
  for (const dependency of ["pg", "better-sqlite3", "sqlite3", "node-gyp"]) {
    if (manifest.dependencies?.[dependency] || manifest.optionalDependencies?.[dependency]) {
      throw new Error(`node-agent runtime package must not depend on ${dependency}.`);
    }
  }
  if (!outputs.some(([, content]) => /node:sqlite/.test(content))) {
    throw new Error("node-agent runtime package is missing its builtin node:sqlite integration.");
  }
  const unexpectedAddons = nativeAddonPaths(packageDir).filter((entry) =>
    !entry.split(path.sep).includes("node-pty"));
  if (unexpectedAddons.length) {
    throw new Error(`node-agent runtime package contains unexpected native addons: ${unexpectedAddons.join(", ")}.`);
  }
}

async function checkEmbeddedControlledInstance(packageDir, name) {
  if (name !== "node-agent") return;
  const artifactDir = path.join(packageDir, "runtime-artifacts");
  const archiveName = fs.readdirSync(artifactDir).find((entry) => entry.endsWith(".tar.gz"));
  if (!archiveName) throw new Error("node-agent package is missing its controlled-instance runtime artifact.");
  let manifest;
  const outputs = [];
  const nativeAddons = [];
  const reads = [];
  await listTar({
    file: path.join(artifactDir, archiveName),
    onReadEntry(entry) {
      if (entry.path.endsWith(".node")) nativeAddons.push(entry.path);
      if (entry.path !== "package.json" && !/^dist\/.*\.(?:js|mjs)$/.test(entry.path)) {
        entry.resume();
        return;
      }
      reads.push(new Promise((resolve, reject) => {
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("error", reject);
        entry.on("end", () => {
          const content = Buffer.concat(chunks).toString("utf8");
          if (entry.path === "package.json") manifest = JSON.parse(content);
          else outputs.push([entry.path, content]);
          resolve();
        });
      }));
    },
  });
  await Promise.all(reads);
  if (!manifest) throw new Error("controlled-instance runtime artifact is missing package.json.");
  assertNoControlPlaneDatabasePayload("controlled-instance runtime artifact", manifest, outputs);
  const unexpectedAddons = nativeAddons.filter((entry) => !entry.split("/").includes("node-pty"));
  if (unexpectedAddons.length) {
    throw new Error(`controlled-instance runtime artifact contains unexpected native addons: ${unexpectedAddons.join(", ")}.`);
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a runtime smoke-test port.");
  return port;
}

async function waitForRuntimeHealth(child, url, name) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let exited = false;
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // The bundled runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} bundled runtime health check failed:\n${output}`);
}

async function checkBundledRuntime(packageDir, manifest, name, definition) {
  if (name !== "control-plane" && name !== "node-agent") return;
  const port = await availablePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-runtime-check-`));
  const binPath = path.join(packageDir, manifest.bin[definition.binName]);
  const args = name === "control-plane"
    ? [binPath, "--host", "127.0.0.1", "--port", String(port), "--data-dir", tempDir, "--auth-mode", "disabled"]
    : [binPath, "--host", "127.0.0.1", "--port", String(port), "--data-dir", tempDir, "--connection-mode", "local-loopback"];
  const child = spawn(process.execPath, args, {
    cwd: packageDir,
    env: { ...process.env, TMPDIR: tempDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const route = name === "control-plane" ? "/api/health" : "/api/node-agent/health";
    const payload = await waitForRuntimeHealth(child, `http://127.0.0.1:${port}${route}`, name);
    const packageVersion = payload?.data?.build?.packageVersion;
    if (!packageVersion || packageVersion === "unknown" || packageVersion !== manifest.version) {
      throw new Error(`${name} bundled runtime reported package version ${JSON.stringify(packageVersion)}; expected ${manifest.version}.`);
    }
    if (name === "node-agent") {
      const invite = spawnSync(process.execPath, [binPath, "invite", "--data-dir", tempDir, "--json"], {
        cwd: packageDir,
        encoding: "utf8",
      });
      if (invite.status !== 0) {
        throw new Error(`node-agent bundled invite command failed:\n${invite.stderr || invite.stdout}`);
      }
      const invitePayload = JSON.parse(invite.stdout);
      if (!invitePayload.nodeId || !invitePayload.joinToken || !invitePayload.expiresAt) {
        throw new Error(`node-agent bundled invite command returned an invalid payload: ${invite.stdout}`);
      }
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function materializeHostNodePtyPrebuild(packageDir, manifest) {
  if (!manifest.bundledDependencies?.includes("node-pty")) return () => {};
  const targetName = `${process.platform}-${process.arch}`;
  const targetDir = path.join(packageDir, "node_modules", "node-pty", "prebuilds", targetName);
  if (fs.existsSync(targetDir)) return () => {};
  const manifestPath = installedDependencyManifests(root, { "node-pty": manifest.dependencies["node-pty"] })["node-pty"];
  const sourceDir = path.join(path.dirname(manifestPath), "prebuilds", targetName);
  if (!fs.existsSync(sourceDir)) throw new Error(`Installed node-pty does not provide the host smoke-test prebuild ${targetName}.`);
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return () => fs.rmSync(targetDir, { recursive: true, force: true });
}

for (const [name, definition] of selected) {
  const packageDir = path.join(root, "release", "npm", name);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== definition.packageName) {
    throw new Error(`${name} package name does not match its runtime definition.`);
  }
  if (manifest.license !== rootPackage.license) {
    throw new Error(`${name} package license must match the root package license.`);
  }
  for (const legalFile of ["LICENSE", "NOTICE"]) {
    if (!fs.existsSync(path.join(packageDir, legalFile))) {
      throw new Error(`${name} package is missing ${legalFile}.`);
    }
  }
  for (const dependency of definition.bundledNativeDependencies || []) {
    if (!manifest.bundledDependencies?.includes(dependency)) {
      throw new Error(`${name} package must declare bundled native dependency ${dependency}.`);
    }
    if (dependency === "node-pty") {
      const bundledRoot = path.join(packageDir, "node_modules", "node-pty");
      const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, "package.json"), "utf8"));
      if (bundledManifest.scripts || bundledManifest.dependencies) {
        throw new Error(`${name} bundled node-pty must not retain install-time scripts or dependencies.`);
      }
      for (const target of ["linux-x64", "linux-arm64"]) {
        if (!fs.existsSync(path.join(bundledRoot, "prebuilds", target, "pty.node"))) {
          throw new Error(`${name} package is missing bundled node-pty prebuild ${target}.`);
        }
      }
    }
  }
  if (fs.existsSync(path.join(packageDir, "src"))) {
    throw new Error(`${name} package contains a source directory.`);
  }
  if (definition.uiDir && !fs.existsSync(path.join(packageDir, "ui", "index.html"))) {
    throw new Error(`${name} package is missing its built UI.`);
  }
  if (definition.input) {
    const runtimeOutputs = [];
    for (const entry of fs.readdirSync(path.join(packageDir, "dist"))) {
      if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
      const content = fs.readFileSync(path.join(packageDir, "dist", entry), "utf8");
      runtimeOutputs.push([entry, content]);
      const lineCount = content.split("\n").length;
      if (content.length / lineCount < 500) {
        throw new Error(`${name} runtime output is not minified: dist/${entry}`);
      }
      const repositoryRequire = content.match(/require\(["'](?:\.\.\/)+(?:apps|packages|scripts)\//);
      if (repositoryRequire) {
        throw new Error(`${name} runtime output references repository source in dist/${entry}: ${repositoryRequire[0]}`);
      }
    }
    for (const dependency of definition.bundledDependencies || []) {
      if (manifest.dependencies?.[dependency]) {
        throw new Error(`${name} bundled dependency ${dependency} must not be declared as an external package dependency.`);
      }
      const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const externalRequire = new RegExp(`require\\(["']${escaped}(?:["'/])`);
      const externalOutput = runtimeOutputs.find(([, content]) => externalRequire.test(content));
      if (externalOutput) {
        throw new Error(`${name} runtime output keeps bundled dependency ${dependency} external in dist/${externalOutput[0]}.`);
      }
    }
    if (name === "controlled-instance") {
      assertNoControlPlaneDatabasePayload(`${name} runtime package`, manifest, runtimeOutputs);
    }
    if (name === "node-agent") assertNodeAgentDatabaseBoundary(packageDir, manifest, runtimeOutputs);
  }
  await checkEmbeddedControlledInstance(packageDir, name);
  const binNames = Object.keys(manifest.bin);
  if (binNames.length !== 1 || binNames[0] !== definition.binName) {
    throw new Error(`${name} package must expose only the ${definition.binName} executable.`);
  }
  const binPath = path.join(packageDir, manifest.bin[definition.binName]);
  if (definition.updateWorkerInput) {
    const workerPath = path.join(packageDir, "bin", "task-handoff-node-update-worker");
    const workerSyntax = spawnSync(process.execPath, ["--check", workerPath], { cwd: root, encoding: "utf8" });
    if (workerSyntax.status !== 0) {
      throw new Error(`${name} update worker syntax check failed:\n${workerSyntax.stderr || workerSyntax.stdout}`);
    }
  }
  if (definition.aggregateDependencies) {
    const syntax = spawnSync(process.execPath, ["--check", binPath], { cwd: root, encoding: "utf8" });
    if (syntax.status !== 0) {
      throw new Error(`${name} package installer syntax check failed:\n${syntax.stderr || syntax.stdout}`);
    }
    const serverCliHelp = spawnSync(process.execPath, [binPath, "--help"], { cwd: root, encoding: "utf8" });
    if (serverCliHelp.status !== 0 || !serverCliHelp.stdout.includes("update")) {
      throw new Error(`${name} package CLI smoke test failed:\n${serverCliHelp.stderr || serverCliHelp.stdout}`);
    }
    if (definition.updateWorkerInput) {
      const workerPath = path.join(packageDir, "bin", "task-handoff-node-update-worker");
      const workerHelp = spawnSync(process.execPath, [workerPath, "--help"], { cwd: packageDir, encoding: "utf8" });
      if (workerHelp.status !== 0 || !workerHelp.stdout.includes("--job-file")) {
        throw new Error(`${name} update worker smoke test failed:\n${workerHelp.stderr || workerHelp.stdout}`);
      }
    }
    for (const dependency of definition.aggregateDependencies) {
      if (manifest.dependencies[dependency] !== manifest.version) {
        throw new Error(`${name} must depend on ${dependency} at the same version.`);
      }
    }
    continue;
  }
  const externalDependencies = Object.fromEntries(Object.entries(manifest.dependencies)
    .filter(([dependency]) => !manifest.bundledDependencies?.includes(dependency)));
  const removeInstalledDependencies = materializeInstalledDependencies(packageDir, root, externalDependencies);
  const removeHostNodePtyPrebuild = materializeHostNodePtyPrebuild(packageDir, manifest);
  try {
    const help = spawnSync(process.execPath, [binPath, "--help"], { cwd: packageDir, encoding: "utf8" });
    if (help.status !== 0 || !help.stdout.includes(definition.binName)) {
      throw new Error(`${name} package CLI smoke test failed:\n${help.stderr || help.stdout}`);
    }
    if (definition.updateWorkerInput) {
      const workerPath = path.join(packageDir, "bin", "task-handoff-node-update-worker");
      const workerHelp = spawnSync(process.execPath, [workerPath, "--help"], { cwd: packageDir, encoding: "utf8" });
      if (workerHelp.status !== 0 || !workerHelp.stdout.includes("--job-file")) {
        throw new Error(`${name} update worker smoke test failed:\n${workerHelp.stderr || workerHelp.stdout}`);
      }
    }
    await checkBundledRuntime(packageDir, manifest, name, definition);
  } finally {
    removeHostNodePtyPrebuild();
    removeInstalledDependencies();
  }
}

console.log(`Checked ${selected.length} runtime package${selected.length === 1 ? "" : "s"}.`);
