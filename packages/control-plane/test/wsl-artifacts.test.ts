import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import {
  WSL_RUNTIME_ARTIFACT_STAGING,
  WSL_RUNTIME_INSTALLER,
  artifactIdentityMatches,
  inspectWslRuntime,
  installWslRuntime,
  wslArtifactTarget,
} from "../src/node-agent/runtimes/wsl-artifacts.ts";

const identity: RuntimeArtifactIdentity = {
  packageName: "@task-handoff/controlled-instance",
  version: "0.0.40",
  platform: "linux",
  arch: "universal",
  formatVersion: 1,
  launcherAbi: 1,
  entrypoint: "index.js",
  sha256: "a".repeat(64),
};

function fakeExecutor(verifyOutput?: string, exitCode = 0) {
  const calls: string[][] = [];
  return {
    calls,
    copied: [] as Array<{ source: string; destination: string }>,
    async copyIntoDistro(_name: string, source: string, destination: string) { this.copied.push({ source, destination }); },
    async execOrThrow(_name: string, argv: readonly string[]) { calls.push([...argv]); return { stdout: "", stderr: "", exitCode: 0 }; },
    async exec(_name: string, argv: readonly string[]) { calls.push([...argv]); return { stdout: verifyOutput ?? "", stderr: "", exitCode }; },
  };
}

test("wsl artifact target is linux with the host arch and launcher ABI 1", () => {
  assert.deepEqual(wslArtifactTarget("x64"), { platform: "linux", arch: "x64", launcherAbi: 1 });
  assert.deepEqual(wslArtifactTarget("arm64"), { platform: "linux", arch: "arm64", launcherAbi: 1 });
});

test("installWslRuntime bridges the artifact and runs the shared runtime installer", async () => {
  const executor = fakeExecutor();
  await installWslRuntime(executor, "th-wsl-inst_a", { identity, archivePath: "C:\\artifacts\\runtime.tar.gz", cacheHit: false });
  assert.deepEqual(executor.copied, [{ source: "C:\\artifacts\\runtime.tar.gz", destination: WSL_RUNTIME_ARTIFACT_STAGING }]);
  const install = executor.calls.find((argv) => argv[0] === "sh")!;
  assert.ok(install[2].includes(WSL_RUNTIME_INSTALLER));
  assert.ok(install[2].includes("--version '0.0.40'"));
  assert.ok(install[2].includes("--launcher-abi 1"));
});

test("inspectWslRuntime matches the active release identity", async () => {
  const executor = fakeExecutor(JSON.stringify(identity));
  assert.equal(await inspectWslRuntime(executor, "th-wsl-inst_a", identity), true);
  const mismatch = fakeExecutor(JSON.stringify({ ...identity, version: "0.0.39" }));
  assert.equal(await inspectWslRuntime(mismatch, "th-wsl-inst_a", identity), false);
  const broken = fakeExecutor("not json", 0);
  assert.equal(await inspectWslRuntime(broken, "th-wsl-inst_a", identity), false);
  const failed = fakeExecutor(JSON.stringify(identity), 1);
  assert.equal(await inspectWslRuntime(failed, "th-wsl-inst_a", identity), false);
});

test("artifactIdentityMatches requires every field including sha256 and entrypoint", () => {
  assert.equal(artifactIdentityMatches(identity, identity), true);
  assert.equal(artifactIdentityMatches({ ...identity, sha256: "b".repeat(64) }, identity), false);
  assert.equal(artifactIdentityMatches({ ...identity, entrypoint: "other.js" }, identity), false);
});

test("an interrupted install surfaces the installer failure and re-running install is idempotent", async () => {
  const failing = {
    calls: [] as string[][],
    async copyIntoDistro() {},
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    async execOrThrow(_name: string, argv: readonly string[]) {
      this.calls.push([...argv]);
      throw Object.assign(new Error("installer failed"), { code: "INSTANCE_RUNTIME_INSTALL_FAILED" });
    },
  };
  await assert.rejects(installWslRuntime(failing, "th-wsl-inst_a", { identity, archivePath: "/x.tar.gz", cacheHit: false }), { code: "INSTANCE_RUNTIME_INSTALL_FAILED" });

  const executor = fakeExecutor();
  await installWslRuntime(executor, "th-wsl-inst_a", { identity, archivePath: "/x.tar.gz", cacheHit: false });
  await installWslRuntime(executor, "th-wsl-inst_a", { identity, archivePath: "/x.tar.gz", cacheHit: true });
  assert.equal(executor.calls.filter((argv) => argv[0] === "sh").length, 2);
  assert.equal(executor.copied.length, 2);
});
