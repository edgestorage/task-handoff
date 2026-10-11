import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  anchorBaseline,
  baselineMarkedFiles,
  computeBaselineVersion,
  rewriteBaselineMarkers,
} from "../scripts/openspec-reanchor-baseline.mjs";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "openspec-reanchor-baseline.mjs");
const marker = (version) => `<!-- baseline:current-1 -->v${version}<!-- /baseline -->`;

test("computes current-1 across patch, minor, and major boundaries", () => {
  assert.equal(computeBaselineVersion("0.0.40"), "0.0.39");
  assert.equal(computeBaselineVersion("v2.3.4"), "2.3.3");
  assert.equal(computeBaselineVersion("0.1.0"), "0.0.0");
  assert.equal(computeBaselineVersion("1.0.0"), "0.0.0");
  assert.throws(() => computeBaselineVersion("not-a-version"));
});

test("rewrites only marked baseline blocks and is idempotent", () => {
  const content = `keep \`v0.0.39\` untouched\nbaseline ${marker("0.0.39")} end`;
  const first = rewriteBaselineMarkers(content, "0.0.38");
  assert.equal(first.changed, true);
  assert.ok(first.content.includes(marker("0.0.38")));
  assert.ok(first.content.includes("keep `v0.0.39` untouched"));

  const second = rewriteBaselineMarkers(first.content, "0.0.38");
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test("anchors marked openspec change docs, skips archive, and reports stale check", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-baseline-"));
  const changeDir = path.join(root, "openspec", "changes", "demo-change");
  const specDir = path.join(changeDir, "specs", "demo");
  fs.mkdirSync(specDir, { recursive: true });
  const designPath = path.join(changeDir, "design.md");
  const specPath = path.join(specDir, "spec.md");
  fs.writeFileSync(designPath, `baseline ${marker("0.0.1")} body\n`);
  fs.writeFileSync(specPath, `N-1 ${marker("0.0.1")}\n`);
  const archiveDir = path.join(root, "openspec", "changes", "archive", "old-change");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, "design.md"), `archived ${marker("0.0.0")}\n`);

  assert.deepEqual(baselineMarkedFiles(root), [designPath, specPath].sort());

  const stale = anchorBaseline({ root, current: "v0.0.40", check: true });
  assert.equal(stale.baseline, "0.0.39");
  assert.deepEqual(stale.changedFiles, ["openspec/changes/demo-change/design.md", "openspec/changes/demo-change/specs/demo/spec.md"]);
  // check mode must not write.
  assert.ok(fs.readFileSync(designPath, "utf8").includes("v0.0.1"));

  const anchored = anchorBaseline({ root, current: "v0.0.40" });
  assert.equal(anchored.changedFiles.length, 2);
  assert.ok(fs.readFileSync(designPath, "utf8").includes(marker("0.0.39")));
  assert.ok(fs.readFileSync(specPath, "utf8").includes(marker("0.0.39")));
  assert.ok(fs.readFileSync(path.join(archiveDir, "design.md"), "utf8").includes("v0.0.0"));

  assert.deepEqual(anchorBaseline({ root, current: "v0.0.40", check: true }).changedFiles, []);
});

test("reanchor CLI exits non-zero in check mode when stale and zero after anchoring", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-baseline-cli-"));
  const changeDir = path.join(root, "openspec", "changes", "demo-change");
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, "proposal.md"), `baseline ${marker("0.0.1")}\n`);

  const runCheck = () => execFileSync(process.execPath, [SCRIPT_PATH, "--root", root, "--current", "v0.0.40", "--check"], { encoding: "utf8" });
  assert.throws(() => runCheck());
  execFileSync(process.execPath, [SCRIPT_PATH, "--root", root, "--current", "v0.0.40"], { encoding: "utf8" });
  assert.doesNotThrow(() => runCheck());
});
