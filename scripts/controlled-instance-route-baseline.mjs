#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nodeRouteSurface } from "../test/fixtures/controlled-instance-route-surface.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { ref: { type: "string" }, out: { type: "string" } },
});
if (!values.ref) throw new Error("Usage: node scripts/controlled-instance-route-baseline.mjs --ref <tag-or-commit> [--out <path>]");

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// Read the object database, never a stale bundle or a checkout over dirty work.
const commit = git("rev-parse", "--verify", "--end-of-options", `${values.ref}^{commit}`).trim();
const sourceRoot = "packages/controlled-instance/src";
const files = git("ls-tree", "-r", "--name-only", commit, "--", sourceRoot)
  .trim().split("\n").filter((file) => file.endsWith(".ts"));
if (!files.length) throw new Error(`No controlled-instance TypeScript source at ${commit}`);
const sources = files.map((file) => ({ file, source: git("show", `${commit}:${file}`) }));
const surface = nodeRouteSurface(root, sources);
if (surface.unresolved.length || surface.upgradeListeners.length) {
  throw new Error(`Unresolved source routes: ${JSON.stringify(surface.unresolved)}`);
}
const routes = [...surface.routes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([, route]) => route);
const snapshot = {
  schemaVersion: 1,
  evidence: "static-route-registration",
  source: {
    ref: values.ref,
    commit,
    root: sourceRoot,
    tree: git("rev-parse", `${commit}:${sourceRoot}`).trim(),
  },
  routes,
};
const output = `${JSON.stringify(snapshot, null, 2)}\n`;
if (values.out) {
  const target = path.resolve(root, values.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output);
} else {
  process.stdout.write(output);
}
