const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const launcherSource = path.join(root, "controlled-instance-rs", "packaging", "dist", "controlled-instance-cli.js");
const executableName = `controlled-instance-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

function createRelease() {
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rust-controlled-instance-launcher-"));
  fs.mkdirSync(path.join(releaseRoot, "dist"));
  fs.copyFileSync(launcherSource, path.join(releaseRoot, "dist", "controlled-instance-cli.js"));
  fs.writeFileSync(path.join(releaseRoot, "dist", "opencode-story-plugin.mjs"), "export default function plugin() {}\n");
  fs.cpSync(path.join(root, "controlled-instance-rs", "packaging", "bin"), path.join(releaseRoot, "bin"), { recursive: true });
  return releaseRoot;
}

test("Rust launcher replaces itself, forwards argv, and preserves the exit status", { skip: process.platform === "win32" }, () => {
  const releaseRoot = createRelease();
  try {
    const executable = path.join(releaseRoot, "bin", executableName);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));\nprocess.exit(23);\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(releaseRoot, "dist", "controlled-instance-cli.js"), "web", "--port", "8080"], { encoding: "utf8" });
    assert.equal(result.status, 23, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.pid, result.pid);
    assert.deepEqual(output.argv, ["web", "--port", "8080"]);
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("Rust launcher fails clearly when the platform binary is missing", () => {
  const releaseRoot = createRelease();
  try {
    const result = spawnSync(process.execPath, [path.join(releaseRoot, "dist", "controlled-instance-cli.js")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Controlled instance runtime binary is missing: bin/${executableName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("launcher ABI bin entrypoint forwards to the Rust launcher", { skip: process.platform === "win32" }, () => {
  const releaseRoot = createRelease();
  try {
    const executable = path.join(releaseRoot, "bin", executableName);
    fs.writeFileSync(executable, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(releaseRoot, "bin", "task-handoff-controlled-instance"), "web"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["web"]);
  } finally {
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }
});
