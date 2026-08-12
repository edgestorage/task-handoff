const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolvePublishedRuntimeArtifact } = require("../packages/control-plane/src/node-agent/runtime-release-source.ts");

const identity = {
  packageName: "@task-handoff/controlled-instance",
  version: "1.2.3",
  platform: "linux",
  arch: "universal",
  formatVersion: 1,
  launcherAbi: 1,
  entrypoint: "dist/controlled-instance-cli.js",
  sha256: "a".repeat(64),
};

test("published runtime metadata is exact and pins the archive checksum", async () => {
  const urls = [];
  const result = await resolvePublishedRuntimeArtifact("1.2.3", "linux", "arm64", async (url) => {
    urls.push(String(url));
    return String(url).endsWith(".manifest.json")
      ? Response.json(identity)
      : new Response(`${"b".repeat(64)}  controlled-instance-runtime-1.2.3-linux-universal.tar.gz\n`);
  });
  assert.deepEqual(result.identity, identity);
  assert.equal(result.source.archiveSha256, "b".repeat(64));
  assert.match(result.source.archiveUrl, /\/v1\.2\.3\/controlled-instance-runtime-1\.2\.3-linux-universal\.tar\.gz$/);
  assert.equal(urls.length, 2);
});

test("node-agent resolves its bundled Linux runtime before the network", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-runtime-"));
  const stem = "controlled-instance-runtime-1.2.3-linux-universal";
  const previous = process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR;
  try {
    fs.writeFileSync(path.join(directory, `${stem}.manifest.json`), `${JSON.stringify(identity)}\n`);
    fs.writeFileSync(path.join(directory, `${stem}.tar.gz.sha256`), `${"b".repeat(64)}  ${stem}.tar.gz\n`);
    fs.writeFileSync(path.join(directory, `${stem}.tar.gz`), "archive");
    process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR = directory;
    let fetchCount = 0;
    const result = await resolvePublishedRuntimeArtifact("1.2.3", "linux", "arm64", async () => {
      fetchCount += 1;
      return new Response("unexpected");
    });
    assert.equal(fetchCount, 0);
    assert.equal(result.source.archivePath, path.join(directory, `${stem}.tar.gz`));
    assert.equal(result.source.archiveSha256, "b".repeat(64));
  } finally {
    if (previous === undefined) delete process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR;
    else process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("published runtime metadata rejects a platform-specific identity", async () => {
  await assert.rejects(
    () => resolvePublishedRuntimeArtifact("1.2.3", "linux", "arm64", async (url) => String(url).endsWith(".manifest.json")
      ? Response.json({ ...identity, platform: "darwin", arch: "arm64" })
      : new Response(`${"b".repeat(64)}  runtime.tar.gz\n`)),
    (error) => error.code === "INSTANCE_RUNTIME_ARTIFACT_INVALID" && /identity mismatch/i.test(error.message),
  );
});

test("published runtime lookup rejects non-Linux targets before network access", async () => {
  let fetchCount = 0;
  await assert.rejects(
    () => resolvePublishedRuntimeArtifact("1.2.3", "darwin", "arm64", async () => {
      fetchCount += 1;
      return new Response("unexpected");
    }),
    (error) => error.code === "INSTANCE_BASE_RUNTIME_INCOMPATIBLE" && /require a Linux x64 or arm64 target/.test(error.message),
  );
  assert.equal(fetchCount, 0);
});

test("published runtime metadata reports missing artifacts before a Node update", async () => {
  await assert.rejects(
    () => resolvePublishedRuntimeArtifact("1.2.3", "linux", "arm64", async () => new Response("missing", { status: 404 })),
    (error) => error.code === "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE" && error.retryable === false,
  );
});

test("the detached Node worker installs only the verified package that owns the service", () => {
  const worker = fs.readFileSync(path.join(__dirname, "..", "scripts", "node-update-worker.cts"), "utf8");
  assert.match(worker, /supportedPackages = new Set\(\["@task-handoff\/node-agent", "@task-handoff\/server"\]\)/);
  assert.match(worker, /`\$\{packageName\}@\$\{targetVersion\}`/);
  assert.match(worker, /verifyNpmArtifactIntegrity\(\)/);
  assert.doesNotMatch(worker, /@task-handoff\/controlled-instance@/);
  assert.doesNotMatch(worker, /taskHandoff.*update/);
});
