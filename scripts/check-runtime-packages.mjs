#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Argument, Command } from "commander";
import { runtimePackages } from "../runtime-packages.config.mjs";

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
  if (fs.existsSync(path.join(packageDir, "src"))) {
    throw new Error(`${name} package contains a source directory.`);
  }
  if (definition.uiDir && !fs.existsSync(path.join(packageDir, "ui", "index.html"))) {
    throw new Error(`${name} package is missing its built UI.`);
  }
  if (definition.input) {
    for (const entry of fs.readdirSync(path.join(packageDir, "dist"))) {
      if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
      const content = fs.readFileSync(path.join(packageDir, "dist", entry), "utf8");
      const lineCount = content.split("\n").length;
      if (content.length / lineCount < 500) {
        throw new Error(`${name} runtime output is not minified: dist/${entry}`);
      }
    }
  }
  const binNames = Object.keys(manifest.bin);
  if (binNames.length !== 1 || binNames[0] !== definition.binName) {
    throw new Error(`${name} package must expose only the ${definition.binName} executable.`);
  }
  const binPath = path.join(packageDir, manifest.bin[definition.binName]);
  if (name === "node-agent") {
    const workerPath = path.join(packageDir, "bin", "task-handoff-node-update-worker");
    const workerSyntax = spawnSync(process.execPath, ["--check", workerPath], { cwd: root, encoding: "utf8" });
    if (workerSyntax.status !== 0) {
      throw new Error(`node-agent update worker syntax check failed:\n${workerSyntax.stderr || workerSyntax.stdout}`);
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
    for (const dependency of definition.aggregateDependencies) {
      if (manifest.dependencies[dependency] !== manifest.version) {
        throw new Error(`${name} must depend on ${dependency} at the same version.`);
      }
    }
    continue;
  }
  const help = spawnSync(process.execPath, [binPath, "--help"], { cwd: root, encoding: "utf8" });
  if (help.status !== 0 || !help.stdout.includes(definition.binName)) {
    throw new Error(`${name} package CLI smoke test failed:\n${help.stderr || help.stdout}`);
  }
  await checkBundledRuntime(packageDir, manifest, name, definition);
}

console.log(`Checked ${selected.length} runtime package${selected.length === 1 ? "" : "s"}.`);
