const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function writeManifest(filePath, manifest) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest)}\n`);
}

test("runtime dependency versions resolve from their pnpm workspace owner without root hoisting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dependencies-"));
  try {
    writeManifest(path.join(root, "package.json"), { private: true });
    writeManifest(path.join(root, "packages/control-plane/package.json"), { name: "control-plane" });
    writeManifest(path.join(root, "packages/control-plane/node_modules/tweetnacl/package.json"), { name: "tweetnacl", version: "1.0.3" });
    fs.mkdirSync(path.join(root, "apps"));
    const { exactInstalledDependencies } = await import("../scripts/runtime-dependency-versions.mjs");
    assert.deepEqual(exactInstalledDependencies(root, { tweetnacl: "^1.0.3" }), { tweetnacl: "1.0.3" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime dependency packaging rejects ambiguous installed workspace versions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dependencies-"));
  try {
    writeManifest(path.join(root, "package.json"), { private: true });
    writeManifest(path.join(root, "packages/one/package.json"), { name: "one" });
    writeManifest(path.join(root, "packages/one/node_modules/example/package.json"), { name: "example", version: "1.0.0" });
    writeManifest(path.join(root, "packages/two/package.json"), { name: "two" });
    writeManifest(path.join(root, "packages/two/node_modules/example/package.json"), { name: "example", version: "2.0.0" });
    fs.mkdirSync(path.join(root, "apps"));
    const { exactInstalledDependencies } = await import("../scripts/runtime-dependency-versions.mjs");
    assert.throws(
      () => exactInstalledDependencies(root, { example: "^1.0.0" }),
      /ambiguous versions: example \(1\.0\.0, 2\.0\.0\)/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
