import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WSL_BASE_TEMPLATE_INVALID,
  WSL_BASE_TEMPLATE_MISSING,
  WSL_DISTRO_MARKER_PATH,
  WSL_DISTRO_OWNERSHIP_CONFLICT,
  WSL_RUNTIME_KIND_LABEL,
  WslDistroIndexStore,
  WslDistroProvisioner,
  assertWslRuntimeLabels,
  ensureWslBaseTemplate,
  wslRuntimeLabels,
  type WslProvisioningExecutor,
} from "../src/node-agent/runtimes/wsl-provisioning.ts";
import { WSL_DISTRO_PREFIX, wslDistroNameForInstance, type WslDistro } from "../src/node-agent/runtimes/wsl-executor.ts";
import {
  parseWslRuntimeEnabledEnv,
  wslRuntimePublishEnabled,
} from "../src/node-agent/runtime-settings.ts";

const BASE_VERSION = "1.2.3";
const BASE_ARCH = "x64";

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function writeBaseTemplateFixture(options: { dir: string; archive?: Buffer; sha256?: string; version?: string; arch?: string }) {
  const version = options.version ?? BASE_VERSION;
  const arch = options.arch ?? BASE_ARCH;
  const archive = options.archive ?? Buffer.from(`base-rootfs-${version}-${arch}`);
  const stem = `wsl-base-${version}-${arch}`;
  fs.writeFileSync(path.join(options.dir, `${stem}.tar.gz`), archive);
  const manifest = {
    id: "wsl-base",
    version,
    platform: "linux",
    arch,
    formatVersion: 1,
    sha256: options.sha256 ?? sha256(archive),
    sizeBytes: archive.length,
    tools: { node: "22.11.0", python: "3.12.3", git: "2.43.0" },
  };
  fs.writeFileSync(path.join(options.dir, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return { archive, manifest };
}

type FakeExecutor = WslProvisioningExecutor & {
  distros: Map<string, WslDistro>;
  markers: Map<string, string>;
  imports: Array<{ name: string; installDir: string; tarballPath: string }>;
  unregistered: string[];
};

function fakeExecutor(initial: WslDistro[] = []): FakeExecutor {
  const distros = new Map(initial.map((distro) => [distro.name, distro]));
  const markers = new Map<string, string>();
  const imports: FakeExecutor["imports"] = [];
  const unregistered: string[] = [];
  return {
    distros,
    markers,
    imports,
    unregistered,
    async listDistros() {
      return [...distros.values()];
    },
    async findDistro(name: string) {
      return distros.get(name);
    },
    async importDistro(input) {
      imports.push({ name: input.name, installDir: input.installDir, tarballPath: input.tarballPath });
      const distro: WslDistro = { name: input.name, state: "Stopped", version: input.version ?? 2, isDefault: false };
      distros.set(input.name, distro);
      return distro;
    },
    async exec(name: string, argv: readonly string[]) {
      if (argv[0] === "cat" && argv[1] === WSL_DISTRO_MARKER_PATH) {
        const content = markers.get(name);
        if (content === undefined) return { stdout: "", stderr: `cat: ${WSL_DISTRO_MARKER_PATH}: No such file or directory`, exitCode: 1 };
        return { stdout: content, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async execOrThrow(name: string, argv: readonly string[]) {
      if (argv[0] === "sh" && typeof argv[2] === "string") {
        const match = /printf '%s' (\S+) \| base64 -d >/.exec(argv[2]);
        if (match) markers.set(name, Buffer.from(match[1], "base64").toString("utf8"));
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async unregister(name: string) {
      unregistered.push(name);
      distros.delete(name);
      markers.delete(name);
    },
  };
}

function provisionerOptions(executor: FakeExecutor, overrides: { sourceDir: string; dataDir: string }) {
  return {
    executor,
    nodeId: "node_test",
    distroRoot: path.join(overrides.dataDir, "distros"),
    baseTemplateCacheDir: path.join(overrides.dataDir, "base-templates"),
    index: new WslDistroIndexStore(path.join(overrides.dataDir, "distros.json")),
    baseTemplateSourceDirs: [overrides.sourceDir],
    expectedBaseTemplateVersion: BASE_VERSION,
    expectedArch: BASE_ARCH,
  };
}

test("base template resolution verifies sha256, caches, and reuses the node-level asset", async () => {
  const sourceDir = tmpDir("wsl-base-src-");
  const cacheDir = tmpDir("wsl-base-cache-");
  const fixture = writeBaseTemplateFixture({ dir: sourceDir });

  const first = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [sourceDir], expectedVersion: BASE_VERSION, expectedArch: BASE_ARCH });
  assert.equal(first.cacheHit, false);
  assert.equal(first.identity.version, BASE_VERSION);
  assert.deepEqual(fs.readFileSync(first.archivePath), fixture.archive);
  assert.ok(fs.existsSync(path.join(path.dirname(first.archivePath), ".ready")));

  // Remove the source: a cached node-level template must still resolve.
  fs.rmSync(sourceDir, { recursive: true, force: true });
  const second = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [sourceDir], expectedVersion: BASE_VERSION, expectedArch: BASE_ARCH });
  assert.equal(second.cacheHit, true);
  assert.equal(second.archivePath, first.archivePath);
});

test("base template resolution rejects a tampered archive and reports a missing template", async () => {
  const sourceDir = tmpDir("wsl-base-bad-");
  writeBaseTemplateFixture({ dir: sourceDir, archive: Buffer.from("real-rootfs"), sha256: sha256("different-rootfs") });
  await assert.rejects(
    () => ensureWslBaseTemplate({ cacheDir: tmpDir("wsl-base-empty-"), sourceDirs: [sourceDir] }),
    (error: { code?: string }) => error.code === WSL_BASE_TEMPLATE_INVALID,
  );
  await assert.rejects(
    () => ensureWslBaseTemplate({ cacheDir: tmpDir("wsl-base-none-"), sourceDirs: [tmpDir("wsl-base-missing-")] }),
    (error: { code?: string }) => error.code === WSL_BASE_TEMPLATE_MISSING,
  );
});

test("a newer visible base template supersedes an older node-level cache entry", async () => {
  const cacheDir = tmpDir("wsl-base-upgrade-cache-");
  const olderDir = tmpDir("wsl-base-old-");
  const newerDir = tmpDir("wsl-base-new-");
  writeBaseTemplateFixture({ dir: olderDir, version: "1.2.3" });
  const older = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [olderDir], expectedVersion: "1.2.3", expectedArch: BASE_ARCH });
  assert.equal(older.cacheHit, false);

  // Same version, same source: the cached asset is reused instead of copied again.
  const reused = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [olderDir], expectedVersion: "1.2.3", expectedArch: BASE_ARCH });
  assert.equal(reused.cacheHit, true);

  // A shipped/pointed-at newer template must reach new distros without hand-clearing the cache.
  writeBaseTemplateFixture({ dir: newerDir, version: "1.3.0" });
  const upgraded = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [newerDir], expectedArch: BASE_ARCH });
  assert.equal(upgraded.cacheHit, false);
  assert.equal(upgraded.identity.version, "1.3.0");

  // The older cached version stays usable when no source is reachable (offline node).
  fs.rmSync(newerDir, { recursive: true, force: true });
  const offline = await ensureWslBaseTemplate({ cacheDir, sourceDirs: [newerDir], expectedArch: BASE_ARCH });
  assert.equal(offline.identity.version, "1.3.0");
  assert.equal(offline.cacheHit, true);
});

test("an explicitly configured base template archive stays a hard requirement", async () => {
  const cacheDir = tmpDir("wsl-base-explicit-cache-");
  const sourceDir = tmpDir("wsl-base-explicit-src-");
  writeBaseTemplateFixture({ dir: sourceDir });
  await ensureWslBaseTemplate({ cacheDir, sourceDirs: [sourceDir], expectedVersion: BASE_VERSION, expectedArch: BASE_ARCH });
  await assert.rejects(
    () => ensureWslBaseTemplate({ cacheDir, archivePath: path.join(tmpDir("wsl-base-gone-"), "missing.tar.gz"), expectedArch: BASE_ARCH }),
    (error: { code?: string }) => error.code === WSL_BASE_TEMPLATE_MISSING,
  );
});

test("provision imports a single base template and writes ownership labels, index, and in-distro marker", async () => {
  const sourceDir = tmpDir("wsl-prov-src-");
  const dataDir = tmpDir("wsl-prov-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const executor = fakeExecutor();
  const provisioner = new WslDistroProvisioner(provisionerOptions(executor, { sourceDir, dataDir }));
  const instance = { id: "inst_wsl_a", runtimeId: "runtime_wsl" };

  const result = await provisioner.provision(instance);
  assert.equal(result.created, true);
  assert.equal(result.distroName, wslDistroNameForInstance(instance.id));
  assert.ok(result.distroName.startsWith(WSL_DISTRO_PREFIX));
  assert.equal(result.labels[WSL_RUNTIME_KIND_LABEL], "wsl");
  assert.equal(result.labels["task-handoff.instance-id"], instance.id);
  assert.equal(result.labels["task-handoff.runtime-id"], instance.runtimeId);
  assert.equal(result.labels["task-handoff.owner-node-id"], "node_test");
  assert.equal(executor.imports.length, 1);
  assert.equal(executor.imports[0].name, result.distroName);
  assert.ok(executor.imports[0].tarballPath.endsWith(".tar.gz"));

  const stored = JSON.parse(executor.markers.get(result.distroName)!);
  assert.deepEqual(stored, result.ownership);
  const index = new WslDistroIndexStore(path.join(dataDir, "distros.json"));
  assert.deepEqual(index.get(result.distroName), result.ownership);
});

test("provision is idempotent and does not create a second distro", async () => {
  const sourceDir = tmpDir("wsl-prov2-src-");
  const dataDir = tmpDir("wsl-prov2-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const executor = fakeExecutor();
  const provisioner = new WslDistroProvisioner(provisionerOptions(executor, { sourceDir, dataDir }));
  const instance = { id: "inst_wsl_b", runtimeId: "runtime_wsl" };

  const first = await provisioner.provision(instance);
  const second = await provisioner.provision(instance);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.distroName, first.distroName);
  assert.equal(executor.imports.length, 1);
  assert.equal([...executor.distros.keys()].filter((name) => name.startsWith(WSL_DISTRO_PREFIX)).length, 1);
});

test("provision repairs a missing in-distro marker from the node index", async () => {
  const sourceDir = tmpDir("wsl-prov3-src-");
  const dataDir = tmpDir("wsl-prov3-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const executor = fakeExecutor();
  const provisioner = new WslDistroProvisioner(provisionerOptions(executor, { sourceDir, dataDir }));
  const instance = { id: "inst_wsl_c", runtimeId: "runtime_wsl" };

  const first = await provisioner.provision(instance);
  executor.markers.delete(first.distroName);
  const second = await provisioner.provision(instance);
  assert.equal(second.created, false);
  assert.deepEqual(JSON.parse(executor.markers.get(first.distroName)!), first.ownership);
});

test("provision refuses same-named distros owned by another instance or node", async () => {
  const sourceDir = tmpDir("wsl-prov4-src-");
  const dataDir = tmpDir("wsl-prov4-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const instance = { id: "inst_wsl_d", runtimeId: "runtime_wsl" };
  const name = wslDistroNameForInstance(instance.id);

  const otherInstanceExecutor = fakeExecutor([{ name, state: "Stopped", version: 2, isDefault: false }]);
  const otherInstanceProvisioner = new WslDistroProvisioner(provisionerOptions(otherInstanceExecutor, { sourceDir, dataDir }));
  await assert.rejects(
    () => otherInstanceProvisioner.provision(instance),
    (error: { code?: string; statusCode?: number }) => error.code === WSL_DISTRO_OWNERSHIP_CONFLICT && error.statusCode === 409,
  );
  assert.equal(otherInstanceExecutor.imports.length, 0);

  const foreignDataDir = tmpDir("wsl-prov4-foreign-");
  const foreignExecutor = fakeExecutor([{ name, state: "Stopped", version: 2, isDefault: false }]);
  const foreignProvisioner = new WslDistroProvisioner(provisionerOptions(foreignExecutor, { sourceDir, dataDir: foreignDataDir }));
  foreignExecutor.markers.set(name, JSON.stringify({
    runtimeKind: "wsl",
    distroName: name,
    instanceId: instance.id,
    runtimeId: instance.runtimeId,
    nodeId: "node_other",
    baseTemplateId: "wsl-base",
    baseTemplateVersion: BASE_VERSION,
    createdAt: new Date().toISOString(),
  }));
  await assert.rejects(
    () => foreignProvisioner.provision(instance),
    (error: { code?: string }) => error.code === WSL_DISTRO_OWNERSHIP_CONFLICT,
  );
  assert.equal(foreignExecutor.imports.length, 0);
  assert.ok(foreignExecutor.distros.has(name));
});

test("distro names honour a persisted containerName and stay injective otherwise", async () => {
  const sourceDir = tmpDir("wsl-prov5-src-");
  const dataDir = tmpDir("wsl-prov5-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const provisioner = new WslDistroProvisioner(provisionerOptions(fakeExecutor(), { sourceDir, dataDir }));
  assert.equal(provisioner.distroNameForInstance({ id: "inst_x", containerName: "th-wsl-custom" }), "th-wsl-custom");
  assert.equal(provisioner.distroNameForInstance({ id: "inst_x", containerName: "  " }), wslDistroNameForInstance("inst_x"));
});

test("runtime labels validate the runtime-kind, owner, and instance identity", () => {
  const labels = wslRuntimeLabels({ instanceId: "inst_l", runtimeId: "runtime_l", nodeId: "node_l", baseTemplateId: "wsl-base" });
  assert.doesNotThrow(() => assertWslRuntimeLabels(labels, { instanceId: "inst_l", runtimeId: "runtime_l", nodeId: "node_l" }));
  assert.throws(
    () => assertWslRuntimeLabels({ ...labels, [WSL_RUNTIME_KIND_LABEL]: "docker" }, { instanceId: "inst_l", runtimeId: "runtime_l", nodeId: "node_l" }),
    (error: { code?: string; statusCode?: number }) => error.code === WSL_DISTRO_OWNERSHIP_CONFLICT && error.statusCode === 409,
  );
  assert.throws(
    () => assertWslRuntimeLabels(undefined, { instanceId: "inst_l", runtimeId: "runtime_l", nodeId: "node_l" }),
    (error: { code?: string }) => error.code === WSL_DISTRO_OWNERSHIP_CONFLICT,
  );
});

test("orphan reconciliation retains, marks reclaimable, and reclaims only owned orphans", async () => {
  const sourceDir = tmpDir("wsl-prov6-src-");
  const dataDir = tmpDir("wsl-prov6-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const executor = fakeExecutor();
  const provisioner = new WslDistroProvisioner(provisionerOptions(executor, { sourceDir, dataDir }));

  const live = await provisioner.provision({ id: "inst_live", runtimeId: "runtime_wsl" });
  const orphan = await provisioner.provision({ id: "inst_orphan", runtimeId: "runtime_wsl" });
  const unownedName = `${WSL_DISTRO_PREFIX}unowned`;
  executor.distros.set(unownedName, { name: unownedName, state: "Stopped", version: 2, isDefault: false });

  const retained = await provisioner.reconcileOrphans({ instanceIds: ["inst_live"] });
  assert.deepEqual(retained.reclaimable, [orphan.distroName]);
  assert.deepEqual(retained.reclaimed, []);
  assert.ok(retained.diagnostics.some((entry) => entry.code === "WSL_DISTRO_ORPHANED" && entry.distroName === orphan.distroName));
  assert.ok(retained.diagnostics.some((entry) => entry.code === "WSL_DISTRO_UNOWNED" && entry.distroName === unownedName));
  assert.ok(executor.distros.has(orphan.distroName));

  const reclaimed = await provisioner.reconcileOrphans({ instanceIds: ["inst_live"], reclaim: true, force: true });
  assert.deepEqual(reclaimed.reclaimed, [orphan.distroName]);
  assert.deepEqual(executor.unregistered, [orphan.distroName]);
  assert.ok(!executor.distros.has(orphan.distroName));
  assert.ok(executor.distros.has(live.distroName));
  assert.ok(executor.distros.has(unownedName));
  assert.equal(new WslDistroIndexStore(path.join(dataDir, "distros.json")).get(orphan.distroName), undefined);
});

test("orphan reconciliation leaves distros owned by another node alone", async () => {
  const sourceDir = tmpDir("wsl-prov7-src-");
  const dataDir = tmpDir("wsl-prov7-data-");
  writeBaseTemplateFixture({ dir: sourceDir });
  const executor = fakeExecutor();
  const provisioner = new WslDistroProvisioner(provisionerOptions(executor, { sourceDir, dataDir }));
  const foreignName = `${WSL_DISTRO_PREFIX}foreign`;
  executor.distros.set(foreignName, { name: foreignName, state: "Stopped", version: 2, isDefault: false });
  new WslDistroIndexStore(path.join(dataDir, "distros.json")).put({
    runtimeKind: "wsl",
    distroName: foreignName,
    instanceId: "inst_other_node",
    runtimeId: "runtime_wsl",
    nodeId: "node_other",
    baseTemplateId: "wsl-base",
    baseTemplateVersion: BASE_VERSION,
    createdAt: new Date().toISOString(),
  });

  const result = await provisioner.reconcileOrphans({ instanceIds: [], reclaim: true, force: true });
  assert.deepEqual(result.reclaimed, []);
  assert.deepEqual(result.reclaimable, []);
  assert.ok(result.diagnostics.some((entry) => entry.code === "WSL_DISTRO_FOREIGN_NODE"));
  assert.deepEqual(executor.unregistered, []);
});

test("WSL runtime publication is gated off by default and can be enabled per node", () => {
  assert.equal(wslRuntimePublishEnabled({}, {}), false);
  assert.equal(wslRuntimePublishEnabled({ wslRuntime: { enabled: false } }, {}), false);
  assert.equal(wslRuntimePublishEnabled({ wslRuntime: { enabled: true } }, {}), true);
  assert.equal(wslRuntimePublishEnabled({ wslRuntime: { enabled: false } }, { TASK_HANDOFF_WSL_RUNTIME_ENABLED: "1" }), true);
  assert.equal(wslRuntimePublishEnabled({ wslRuntime: { enabled: true } }, { TASK_HANDOFF_WSL_RUNTIME_ENABLED: "off" }), false);
  assert.equal(wslRuntimePublishEnabled({ wslRuntime: { enabled: true } }, { TASK_HANDOFF_WSL_RUNTIME_ENABLED: "maybe" }), true);
  assert.equal(parseWslRuntimeEnabledEnv("YES"), true);
  assert.equal(parseWslRuntimeEnabledEnv("0"), false);
  assert.equal(parseWslRuntimeEnabledEnv("nope"), undefined);
});
