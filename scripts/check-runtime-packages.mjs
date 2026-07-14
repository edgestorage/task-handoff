#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Argument, Command } from "commander";
import { runtimePackages } from "../runtime-packages.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const program = new Command()
  .name("check-runtime-packages")
  .description("Validate assembled TaskHandoff runtime npm packages.")
  .addArgument(new Argument("[target]", "check one runtime package").choices(Object.keys(runtimePackages)))
  .parse(process.argv);
const [requestedTarget] = program.processedArgs;
const selected = requestedTarget
  ? Object.entries(runtimePackages).filter(([name]) => name === requestedTarget)
  : Object.entries(runtimePackages);

for (const [name, definition] of selected) {
  const packageDir = path.join(root, "release", "npm", name);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== definition.packageName) {
    throw new Error(`${name} package name does not match its runtime definition.`);
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
}

console.log(`Checked ${selected.length} runtime package${selected.length === 1 ? "" : "s"}.`);
