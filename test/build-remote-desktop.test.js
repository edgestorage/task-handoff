const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");

test("local remote desktop build installs an atomic native managed app", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-desktop-build-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packageDir = path.join(directory, "source", "package");
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  const executable = process.platform === "win32" ? "task-handoff-desktop-streaming.exe" : "task-handoff-desktop-streaming";
  const builtComponent = path.resolve(__dirname, "..", "remote-desktop-rs", "target", "debug", executable);
  const sourceBinary = process.platform === "win32" ? builtComponent : path.join(packageDir, "bin", executable);
  if (process.platform === "win32") {
    if (!fs.existsSync(sourceBinary)) {
      t.skip(`Windows component is not built at ${sourceBinary}`);
      return;
    }
    fs.copyFileSync(sourceBinary, path.join(packageDir, "bin", executable));
  } else {
    fs.writeFileSync(sourceBinary, "#!/bin/sh\nprintf '0.0.46\\n'\n", { mode: 0o755 });
  }
  fs.writeFileSync(path.join(packageDir, "README.md"), "test\n");
  const archive = path.join(directory, "remote-desktop.tgz");
  await tar.c({ cwd: path.join(directory, "source"), file: archive, gzip: true, sync: true }, ["package"]);
  const metadata = {
    version: "1.2.3",
    platform: process.platform,
    arch: process.arch,
    package: `@task-handoff/remote-desktop-${process.platform}-${process.arch}`,
    integrity: `sha512-${crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`,
  };
  const instanceDir = path.join(directory, "node-agent", "local-instances", "inst_test");
  const oldRoot = path.join(instanceDir, "managed-apps", "native", "remote-desktop");
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "old.txt"), "old\n");

  const { installRemoteDesktopPackage } = await import("../scripts/build-remote-desktop.mjs");
  const installed = await installRemoteDesktopPackage({ archive, metadata, instanceDir });
  const manifest = JSON.parse(fs.readFileSync(path.join(oldRoot, "managed-app.json"), "utf8"));
  assert.equal(installed.version, "0.0.46");
  assert.equal(manifest.appId, "remote-desktop");
  assert.equal(manifest.version, metadata.version);
  assert.equal(manifest.integrity, metadata.integrity);
  assert.equal(manifest.launchPath, `bin/${executable}`);
  assert.ok(manifest.files.includes(`bin/${executable}`));
  assert.equal(fs.existsSync(path.join(oldRoot, "old.txt")), false);
  assert.equal(fs.existsSync(path.join(oldRoot, "bin", executable)), true);
});
