const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("CI assembles portable runtime packages from both Linux node-pty prebuilds", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

  for (const identity of ["linux-x64", "linux-arm64"]) {
    const [platform, arch] = identity.split("-");
    assert.match(workflow, new RegExp(`platform: ${platform}\\n\\s+arch: ${arch}`));
  }
  assert.match(workflow, /node:24-bullseye/);
  assert.match(workflow, /runtime-packages:\n\s+needs: node-pty-prebuilds/);
  assert.match(workflow, /pattern: ci-node-pty-prebuild-\*/);
  assert.match(workflow, /path: release\/node-pty-prebuilds[\s\S]*merge-multiple: true/);
  assert.match(workflow, /pnpm runtime:artifact -- --version "\$version" --prebuilds-dir release\/node-pty-prebuilds/);
  assert.equal((workflow.match(/pnpm runtime:pack/g) || []).length, 1);
  assert.ok(workflow.indexOf("pattern: ci-node-pty-prebuild-*") < workflow.indexOf("pnpm runtime:artifact"));
  assert.ok(workflow.indexOf("pnpm runtime:artifact") < workflow.indexOf("run: pnpm runtime:pack"));
});
