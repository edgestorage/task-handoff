#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHECK_DIRS = ["bin", "dist"];
const CHECK_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const SELF = path.resolve(__filename);

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    if (!entry.isFile() || !CHECK_EXTENSIONS.has(path.extname(entry.name))) {
      return [];
    }
    return [fullPath];
  });
}

const files = CHECK_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
  .filter((file) => path.resolve(file) !== SELF)
  .sort();

if (files.length === 0) {
  console.error("No built JavaScript files found to check.");
  process.exit(1);
}

for (const file of files) {
  const relative = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`node --check failed for ${relative}`);
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
