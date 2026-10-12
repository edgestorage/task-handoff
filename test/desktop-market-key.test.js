const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DEFAULT_MARKET_CATALOG_PUBLIC_KEY } = require("../apps/desktop-shell/src/config.cjs");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "prepare-desktop-market-key.mjs");

function materialize(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-market-key-"));
  const out = path.join(dir, "market-catalog-public-key.txt");
  execFileSync(process.execPath, [script, "--out", out], {
    env: { ...process.env, TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY: env },
    stdio: "pipe",
  });
  return { dir, out };
}

test("desktop market key materialization writes the CI override", () => {
  const { dir, out } = materialize("ci-market-key");
  try {
    assert.equal(fs.readFileSync(out, "utf8").trim(), "ci-market-key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop market key materialization falls back to the pinned official key", () => {
  const { dir, out } = materialize("");
  try {
    assert.equal(fs.readFileSync(out, "utf8").trim(), DEFAULT_MARKET_CATALOG_PUBLIC_KEY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
