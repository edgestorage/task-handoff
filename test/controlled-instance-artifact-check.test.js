const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");

const root = path.resolve(__dirname, "..");

async function writeRustFixture({ extraEntries = {} } = {}) {
  const payload = await fs.mkdtemp(path.join(os.tmpdir(), "controlled-instance-rust-payload-"));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "controlled-instance-rust-artifact-"));
  const files = {
    "package.json": `${JSON.stringify({
      name: "@task-handoff/controlled-instance",
      version: "9.9.9",
      main: "dist/controlled-instance-cli.js",
      bin: { "task-handoff-controlled-instance": "bin/task-handoff-controlled-instance" },
      taskHandoffRuntime: {
        implementation: "rust",
        binaries: [{ platform: "linux", arch: "x64", path: "bin/controlled-instance-linux-x64" }],
      },
    }, null, 2)}\n`,
    "dist/controlled-instance-cli.js": 'const name = `controlled-instance-${process.platform}-${process.arch}`;\n',
    "dist/opencode-story-plugin.mjs": "export default function plugin() {}\n",
    "bin/task-handoff-controlled-instance": 'require("../dist/controlled-instance-cli.js");\n',
    "ui/index.html": "<!doctype html>\n",
    "ui/assets/app.js": "console.log('frozen ui');\n",
    "bin/controlled-instance-linux-x64": "#!/bin/sh\nexit 0\n",
    ...extraEntries,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(payload, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, { mode: relativePath.startsWith("bin/") || relativePath.startsWith("dist/") ? 0o755 : 0o644 });
  }
  const { computePayloadSha256 } = await import("../scripts/runtime-artifact.mjs");
  const manifest = {
    packageName: "@task-handoff/controlled-instance",
    version: "9.9.9",
    platform: "linux",
    arch: "x64",
    formatVersion: 1,
    launcherAbi: 1,
    entrypoint: "dist/controlled-instance-cli.js",
    sha256: await computePayloadSha256(payload),
  };
  await fs.writeFile(path.join(payload, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const archivePath = path.join(output, "controlled-instance-runtime-9.9.9-linux-x64.tar.gz");
  await tar.create({ cwd: payload, file: archivePath, gzip: true, portable: true, noMtime: true }, Object.keys(files).concat("runtime-manifest.json"));
  return {
    output,
    async cleanup() {
      await fs.rm(payload, { recursive: true, force: true });
      await fs.rm(output, { recursive: true, force: true });
    },
  };
}

test("artifact checker accepts the frozen UI and rejects Rust payload business JavaScript", async () => {
  const valid = await writeRustFixture();
  const invalid = await writeRustFixture({ extraEntries: { "src/fallback.js": "console.log('business logic');\n" } });
  try {
    const { checkControlledInstanceArtifact } = await import("../scripts/controlled-instance-artifact-check.mjs");
    const checked = await checkControlledInstanceArtifact(valid.output);
    assert.equal(checked.implementation, "rust");
    await assert.rejects(checkControlledInstanceArtifact(invalid.output), /must not contain source files/);
  } finally {
    await valid.cleanup();
    await invalid.cleanup();
  }
});
