import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWslBaseTemplate } from "../../../scripts/build-wsl-base-template.mjs";
import { WslBaseTemplateManifestSchema } from "../src/node-agent/runtimes/wsl-provisioning.ts";

function syntheticRootfs() {
  const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), "th-wsl-rootfs-"));
  for (const directory of ["etc", "usr/bin", "lib/systemd", "proc", "sys", "dev", "run", "opt"]) {
    fs.mkdirSync(path.join(rootfs, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(rootfs, "etc/os-release"), "ID=ubuntu\n");
  fs.writeFileSync(path.join(rootfs, "usr/bin/node"), "#!/bin/sh\necho v22\n", { mode: 0o755 });
  fs.writeFileSync(path.join(rootfs, "lib/systemd/systemd"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(rootfs, "usr/bin/systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(rootfs, "proc/mounts"), "should not be packaged\n");
  return rootfs;
}

test("buildWslBaseTemplate enables systemd and emits a schema-valid versioned manifest", async () => {
  const rootfs = syntheticRootfs();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-wsl-out-"));
  const result = await buildWslBaseTemplate({ rootfs, version: "1.2.3", arch: "x64", outputDir, now: () => new Date("2026-01-01T00:00:00.000Z") });
  assert.ok(fs.existsSync(result.archivePath));
  assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.sizeBytes, fs.statSync(result.archivePath).size);
  const parsed = WslBaseTemplateManifestSchema.parse(result.manifest);
  assert.equal(parsed.id, "wsl-base");
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.arch, "x64");
  assert.equal(parsed.platform, "linux");
  assert.equal(fs.readFileSync(path.join(rootfs, "etc/wsl.conf"), "utf8"), "[boot]\nsystemd=true\n");
});

test("buildWslBaseTemplate rejects a rootfs without a systemd init", async () => {
  const rootfs = syntheticRootfs();
  fs.rmSync(path.join(rootfs, "lib/systemd/systemd"));
  await assert.rejects(
    buildWslBaseTemplate({ rootfs, version: "1.2.3", arch: "x64", outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "th-wsl-nosystemd-")) }),
    { message: /missing a systemd init/ },
  );
});

test("buildWslBaseTemplate is deterministic for a fixed createdAt and excludes mounted roots", async () => {
  const first = await buildWslBaseTemplate({ rootfs: syntheticRootfs(), version: "1.2.3", arch: "x64", outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "th-wsl-a-")), now: () => new Date("2026-01-01T00:00:00.000Z") });
  const second = await buildWslBaseTemplate({ rootfs: syntheticRootfs(), version: "1.2.3", arch: "x64", outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "th-wsl-b-")), now: () => new Date("2026-01-01T00:00:00.000Z") });
  assert.equal(first.manifest.sha256, second.manifest.sha256);
  await assert.rejects(buildWslBaseTemplate({ version: "1.2.3", arch: "x64", outputDir: "/tmp" }), { message: /--rootfs is required/ });
});
