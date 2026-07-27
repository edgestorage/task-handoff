const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");

const {
  RuntimeArtifactError,
  RuntimeArtifactResolver,
  computeRuntimePayloadSha256,
  installRuntimeArtifact,
  readRuntimeArtifactManifest,
  rollbackRuntimeRelease,
  runtimeReleaseKey,
  switchCurrentRuntime,
  validateExtractedRuntimeArtifact,
} = require("../packages/control-plane/src/node-agent/runtime-artifacts.ts");
const { LocalhostRuntimeAdapter } = require("../packages/control-plane/src/node-agent/app.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");

async function fixture(version = "1.2.3", overrides = {}) {
  const { payloadMarker = version, ...identityOverrides } = overrides;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-fixture-"));
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "controlled-instance-cli.js"), `console.log(${JSON.stringify(payloadMarker)});\n`);
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "@task-handoff/controlled-instance", version })}\n`);
  const identity = {
    packageName: "@task-handoff/controlled-instance",
    version,
    platform: "linux",
    arch: "x64",
    formatVersion: 1,
    launcherAbi: 1,
    entrypoint: "dist/controlled-instance-cli.js",
    sha256: await computeRuntimePayloadSha256(root),
    ...identityOverrides,
  };
  await fs.writeFile(path.join(root, "runtime-manifest.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const archivePath = `${root}.tar.gz`;
  await tar.create({ cwd: root, file: archivePath, gzip: true, portable: true, noMtime: true }, ["dist", "package.json", "runtime-manifest.json"]);
  const bytes = await fs.readFile(archivePath);
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    root,
    archivePath,
    archiveSha256,
    bytes,
    identity,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(archivePath, { force: true });
    },
  };
}

test("artifact manifest and canonical payload digest are strict and shared with the release script", async () => {
  const item = await fixture();
  try {
    assert.deepEqual(await readRuntimeArtifactManifest(item.root), item.identity);
    assert.deepEqual(await validateExtractedRuntimeArtifact(item.root, item.identity, { platform: "linux", arch: "x64", launcherAbi: 1 }), item.identity);
    const releaseScript = await import("../scripts/runtime-artifact.mjs");
    assert.equal(await releaseScript.computePayloadSha256(item.root), item.identity.sha256);
  } finally {
    await item.cleanup();
  }
});

test("universal artifacts validate on every supported host identity", async () => {
  const item = await fixture("1.2.3", { platform: "universal", arch: "universal" });
  try {
    await validateExtractedRuntimeArtifact(item.root, item.identity, { platform: "linux", arch: "arm64", launcherAbi: 1 });
    await validateExtractedRuntimeArtifact(item.root, item.identity, { platform: "darwin", arch: "x64", launcherAbi: 1 });
  } finally {
    await item.cleanup();
  }
});

test("runtime artifact copies only the node-pty runtime and strips debug symbols", async () => {
  const releaseScript = await import("../scripts/runtime-artifact.mjs");
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-source-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-runtime-"));
  try {
    await fs.mkdir(path.join(source, "lib"), { recursive: true });
    await fs.mkdir(path.join(source, "prebuilds", "linux-x64"), { recursive: true });
    await fs.mkdir(path.join(source, "prebuilds", "linux-arm64"), { recursive: true });
    await fs.mkdir(path.join(source, "prebuilds", "darwin-arm64"), { recursive: true });
    await fs.mkdir(path.join(source, "src"), { recursive: true });
    await fs.writeFile(path.join(source, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(source, "package.json"), '{"name":"node-pty"}\n');
    await fs.writeFile(path.join(source, "lib", "index.js"), "module.exports = {};\n");
    await fs.writeFile(path.join(source, "prebuilds", "linux-x64", "pty.node"), "native");
    await fs.writeFile(path.join(source, "prebuilds", "linux-x64", "pty.pdb"), "debug");
    await fs.writeFile(path.join(source, "prebuilds", "linux-arm64", "pty.node"), "native-arm64");
    await fs.writeFile(path.join(source, "prebuilds", "darwin-arm64", "pty.node"), "must-not-ship");
    await fs.writeFile(path.join(source, "src", "pty.cc"), "source");

    await releaseScript.copyNodePtyRuntime(destination, source);

    const copied = path.join(destination, "node_modules", "node-pty");
    assert.equal(await fs.readFile(path.join(copied, "prebuilds", "linux-x64", "pty.node"), "utf8"), "native");
    assert.equal(await fs.readFile(path.join(copied, "prebuilds", "linux-arm64", "pty.node"), "utf8"), "native-arm64");
    await assert.rejects(fs.lstat(path.join(copied, "prebuilds", "linux-x64", "pty.pdb")), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(copied, "prebuilds", "darwin-arm64")), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(copied, "src")), { code: "ENOENT" });
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
  }
});

test("node-pty prebuild collection keeps only the Linux runtime payload", async () => {
  const prebuildScript = await import("../scripts/node-pty-prebuild.mjs");
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-package-"));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-output-"));
  try {
    const prebuild = path.join(source, "prebuilds", "linux-x64");
    await fs.mkdir(path.join(prebuild, "obj.target"), { recursive: true });
    await fs.writeFile(path.join(prebuild, "pty.node"), "native");
    await fs.writeFile(path.join(prebuild, "obj.target", "pty.o"), "build-intermediate");
    await prebuildScript.collectNodePtyPrebuild({ output, platform: "linux", arch: "x64", packageDir: source });
    assert.equal(await fs.readFile(path.join(output, "linux-x64", "pty.node"), "utf8"), "native");
    await assert.rejects(fs.lstat(path.join(output, "linux-x64", "obj.target")), { code: "ENOENT" });
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("Linux runtime requires every supported node-pty prebuild", async () => {
  const releaseScript = await import("../scripts/runtime-artifact.mjs");
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-source-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-runtime-"));
  const prebuilds = await fs.mkdtemp(path.join(os.tmpdir(), "node-pty-prebuilds-"));
  try {
    await fs.mkdir(path.join(source, "lib"), { recursive: true });
    await fs.writeFile(path.join(source, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(source, "package.json"), '{"name":"node-pty"}\n');
    await fs.writeFile(path.join(source, "lib", "index.js"), "module.exports = {};\n");
    await fs.mkdir(path.join(prebuilds, releaseScript.requiredNodePtyTargets[0]), { recursive: true });
    await assert.rejects(releaseScript.copyNodePtyRuntime(destination, source, prebuilds), /missing node-pty prebuild/);
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rm(prebuilds, { recursive: true, force: true });
  }
});

for (const [name, mutate, expected] of [
  ["version mismatch", (identity) => ({ ...identity, version: "9.9.9" }), /version mismatch/],
  ["platform mismatch", (identity) => ({ ...identity, platform: "darwin" }), /platform mismatch/],
  ["architecture mismatch", (identity) => ({ ...identity, arch: "arm64" }), /arch mismatch/],
  ["manifest tampering", (identity) => ({ ...identity, entrypoint: "dist/other.js" }), /entrypoint mismatch/],
  ["payload hash failure", (identity) => ({ ...identity, sha256: "0".repeat(64) }), /SHA-256 mismatch/],
]) {
  test(`artifact validation rejects ${name}`, async () => {
    const item = await fixture();
    try {
      await assert.rejects(validateExtractedRuntimeArtifact(item.root, mutate(item.identity)), expected);
    } finally {
      await item.cleanup();
    }
  });
}

test("artifact validation rejects a missing entrypoint", async () => {
  const item = await fixture();
  try {
    await fs.rm(path.join(item.root, item.identity.entrypoint));
    await assert.rejects(validateExtractedRuntimeArtifact(item.root, item.identity), /entrypoint is missing/);
  } finally {
    await item.cleanup();
  }
});

test("resolver single-flights downloads, atomically caches, and returns cache hits", async () => {
  const item = await fixture();
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-cache-"));
  let fetchCount = 0;
  const resolver = new RuntimeArtifactResolver({
    cacheDir,
    fetchImpl: async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(item.bytes);
    },
  });
  try {
    const source = { archiveUrl: "https://release.test/runtime.tar.gz", archiveSha256: item.archiveSha256 };
    const results = await Promise.all(Array.from({ length: 8 }, () => resolver.resolve(item.identity, source)));
    assert.equal(fetchCount, 1);
    assert.equal(new Set(results.map((result) => result.archivePath)).size, 1);
    assert.equal((await resolver.resolve(item.identity, source)).cacheHit, true);
    assert.equal(fetchCount, 1);
    assert.deepEqual((await fs.readdir(path.join(cacheDir, "archives"))).filter((name) => name.endsWith(".part")), []);
  } finally {
    await item.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolver propagates one concurrent failure and safely retries", async () => {
  const item = await fixture();
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-cache-"));
  let fail = true;
  let fetchCount = 0;
  const resolver = new RuntimeArtifactResolver({
    cacheDir,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fail) return new Response("unavailable", { status: 503 });
      return new Response(item.bytes);
    },
  });
  const source = { archiveUrl: "https://release.test/runtime.tar.gz", archiveSha256: item.archiveSha256 };
  try {
    const settled = await Promise.allSettled([resolver.resolve(item.identity, source), resolver.resolve(item.identity, source)]);
    assert.equal(fetchCount, 1);
    assert.ok(settled.every((result) => result.status === "rejected" && result.reason.code === "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE"));
    fail = false;
    assert.equal((await resolver.resolve(item.identity, source)).cacheHit, false);
    assert.equal(fetchCount, 2);
  } finally {
    await item.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolver installs an artifact carried by node-agent without fetching", async () => {
  const item = await fixture("1.2.3", { platform: "universal", arch: "universal" });
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-cache-"));
  let fetchCount = 0;
  const resolver = new RuntimeArtifactResolver({ cacheDir, fetchImpl: async () => { fetchCount += 1; return new Response("unexpected"); } });
  try {
    const result = await resolver.resolve(item.identity, { archivePath: item.archivePath, archiveSha256: item.archiveSha256 });
    assert.equal(result.cacheHit, false);
    assert.equal(fetchCount, 0);
    assert.equal((await resolver.resolve(item.identity, { archivePath: item.archivePath, archiveSha256: item.archiveSha256 })).cacheHit, true);
  } finally {
    await item.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolver does not single-flight different immutable identities for one version", async () => {
  const first = await fixture("1.2.3");
  const second = await fixture("1.2.3");
  await fs.writeFile(path.join(second.root, "dist", "controlled-instance-cli.js"), "console.log('different');\n");
  second.identity.sha256 = await computeRuntimePayloadSha256(second.root);
  await fs.writeFile(path.join(second.root, "runtime-manifest.json"), `${JSON.stringify(second.identity, null, 2)}\n`);
  await tar.create({ cwd: second.root, file: second.archivePath, gzip: true, portable: true, noMtime: true }, ["dist", "package.json", "runtime-manifest.json"]);
  second.bytes = await fs.readFile(second.archivePath);
  second.archiveSha256 = createHash("sha256").update(second.bytes).digest("hex");
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-cache-"));
  let fetchCount = 0;
  const resolver = new RuntimeArtifactResolver({
    cacheDir,
    fetchImpl: async (url) => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(String(url).includes("second") ? second.bytes : first.bytes);
    },
  });
  try {
    const [one, two] = await Promise.all([
      resolver.resolve(first.identity, { archiveUrl: "https://release.test/first", archiveSha256: first.archiveSha256 }),
      resolver.resolve(second.identity, { archiveUrl: "https://release.test/second", archiveSha256: second.archiveSha256 }),
    ]);
    assert.equal(fetchCount, 2);
    assert.notEqual(one.archivePath, two.archivePath);
    assert.equal(one.identity.sha256, first.identity.sha256);
    assert.equal(two.identity.sha256, second.identity.sha256);
  } finally {
    await first.cleanup();
    await second.cleanup();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("Windows current junction switching supports consecutive updates", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-current-win32-"));
  try {
    await fs.mkdir(path.join(runtimeRoot, "releases", "1.0.0"), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, "releases", "1.1.0"), { recursive: true });
    await switchCurrentRuntime(runtimeRoot, "1.0.0", "win32");
    await switchCurrentRuntime(runtimeRoot, "1.1.0", "win32");
    assert.equal(await fs.realpath(path.join(runtimeRoot, "current")), await fs.realpath(path.join(runtimeRoot, "releases", "1.1.0")));
    assert.deepEqual((await fs.readdir(runtimeRoot)).filter((name) => name.startsWith(".current-") || name.startsWith(".previous-current-")), []);
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("installer keeps current atomic, reuses valid releases, quarantines corruption, and rolls back", async () => {
  const oldArtifact = await fixture("1.0.0");
  const newArtifact = await fixture("1.1.0");
  const oldRelease = runtimeReleaseKey(oldArtifact.identity);
  const newRelease = runtimeReleaseKey(newArtifact.identity);
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-install-"));
  try {
    await installRuntimeArtifact({ archivePath: oldArtifact.archivePath, identity: oldArtifact.identity, runtimeRoot, launcherAbi: 1 });
    await assert.rejects(
      installRuntimeArtifact({ archivePath: newArtifact.archivePath, identity: newArtifact.identity, runtimeRoot, launcherAbi: 1, faultInjection: "after-extract" }),
      (error) => error.code === "INSTANCE_RUNTIME_INSTALL_FAILED" && /Injected failure/.test(error.cause?.message ?? ""),
    );
    assert.match(await fs.readlink(path.join(runtimeRoot, "current")), new RegExp(`${oldRelease}$`));

    const installed = await installRuntimeArtifact({ archivePath: newArtifact.archivePath, identity: newArtifact.identity, runtimeRoot, launcherAbi: 1 });
    assert.equal(installed.previousVersion, "1.0.0");
    assert.match(await fs.readlink(path.join(runtimeRoot, "current")), new RegExp(`${newRelease}$`));
    assert.equal((await installRuntimeArtifact({ archivePath: newArtifact.archivePath, identity: newArtifact.identity, runtimeRoot, launcherAbi: 1 })).reused, true);

    await fs.writeFile(path.join(runtimeRoot, "releases", newRelease, "dist", "controlled-instance-cli.js"), "corrupt\n");
    assert.equal((await installRuntimeArtifact({ archivePath: newArtifact.archivePath, identity: newArtifact.identity, runtimeRoot, launcherAbi: 1 })).reused, false);
    assert.ok((await fs.readdir(path.join(runtimeRoot, "quarantine"))).some((name) => name.startsWith("1.1.0-linux-x64")));
    assert.equal(await rollbackRuntimeRelease(runtimeRoot), "1.0.0");
    assert.match(await fs.readlink(path.join(runtimeRoot, "current")), new RegExp(`${oldRelease}$`));
  } finally {
    await oldArtifact.cleanup();
    await newArtifact.cleanup();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("launcher ABI incompatibility is structured and leaves active release unchanged", async () => {
  const oldArtifact = await fixture("1.0.0");
  const incompatible = await fixture("2.0.0", { launcherAbi: 2 });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-install-"));
  try {
    await installRuntimeArtifact({ archivePath: oldArtifact.archivePath, identity: oldArtifact.identity, runtimeRoot, launcherAbi: 1 });
    await assert.rejects(
      installRuntimeArtifact({ archivePath: incompatible.archivePath, identity: incompatible.identity, runtimeRoot, launcherAbi: 1 }),
      (error) => error instanceof RuntimeArtifactError && error.code === "INSTANCE_BASE_RUNTIME_INCOMPATIBLE",
    );
    assert.match(await fs.readlink(path.join(runtimeRoot, "current")), new RegExp(`${runtimeReleaseKey(oldArtifact.identity)}$`));
    assert.equal((await fs.readdir(path.join(runtimeRoot, "releases"))).some((name) => name.startsWith("2.0.0-")), false);
  } finally {
    await oldArtifact.cleanup();
    await incompatible.cleanup();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("same-version development artifacts install and roll back by exact SHA-256 identity", async () => {
  const first = await fixture("0.0.1", { payloadMarker: "first" });
  const second = await fixture("0.0.1", { payloadMarker: "second" });
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-same-version-"));
  try {
    await installRuntimeArtifact({ archivePath: first.archivePath, identity: first.identity, runtimeRoot, launcherAbi: 1 });
    await installRuntimeArtifact({ archivePath: second.archivePath, identity: second.identity, runtimeRoot, launcherAbi: 1 });
    assert.equal((await readRuntimeArtifactManifest(path.join(runtimeRoot, "current"))).sha256, second.identity.sha256);
    assert.equal((await fs.readdir(path.join(runtimeRoot, "releases"))).length, 2);
    assert.equal(await rollbackRuntimeRelease(runtimeRoot), "0.0.1");
    assert.equal((await readRuntimeArtifactManifest(path.join(runtimeRoot, "current"))).sha256, first.identity.sha256);
  } finally {
    await first.cleanup();
    await second.cleanup();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("Local Runtime adapter installs into an instance-private current release", async () => {
  const item = await fixture("2.0.0");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-runtime-adapter-"));
  try {
    const adapter = new LocalhostRuntimeAdapter(async () => ({ stdout: "", stderr: "" }), nodeAgentStorePaths(dataDir), () => "http://127.0.0.1:8091", "linux", "x64");
    const context = { instance: { id: "inst_private" } };
    await adapter.installRuntime(context, { archivePath: item.archivePath, identity: item.identity, cacheHit: false });
    assert.equal(await adapter.inspectRuntime(context, item.identity), true);
    assert.equal(await adapter.inspectRuntime(context, { ...item.identity, version: "1.0.0" }), false);
    const manifest = JSON.parse(await fs.readFile(path.join(dataDir, "local-instances", "inst_private", "runtime", "current", "runtime-manifest.json"), "utf8"));
    assert.equal(manifest.version, "2.0.0");
  } finally {
    await item.cleanup();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
