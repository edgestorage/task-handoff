const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/desktop-release.yml"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("desktop releases publish updater metadata to the public release repository", () => {
  assert.deepEqual(manifest.build.publish, [{ provider: "github", owner: "edgestorage", repo: "task-handoff" }]);
  assert.match(workflow, /GH_REPO: edgestorage\/task-handoff/);
  assert.match(workflow, /release\/\*\.blockmap/);
  for (const channel of ["latest", "beta", "alpha"]) {
    assert.match(workflow, new RegExp(`release/${channel}\\.yml`));
    assert.match(workflow, new RegExp(`release/${channel}-mac\\.yml`));
    assert.match(workflow, new RegExp(`release/${channel}-linux\\.yml`));
  }
  assert.equal((workflow.match(/--config\.publish\.channel=\$\{\{ steps\.version\.outputs\.channel \}\}/g) || []).length, 2);
  assert.match(workflow, /echo "channel=\$channel" >> "\$GITHUB_OUTPUT"/);
  assert.equal((workflow.match(/channel="latest"/g) || []).length, 2);
  assert.equal((workflow.match(/if \[\[ "\$version" == \*-\* \]\]; then/g) || []).length, 2);
  assert.match(workflow, /\^\$\{channel\}\\\\\.yml\$/);
  assert.match(workflow, /\^\$\{channel\}-mac\\\\\.yml\$/);
  assert.match(workflow, /\^\$\{channel\}-linux\\\\\.yml\$/);
});

test("macOS updater metadata is generated from one dual-architecture build", () => {
  assert.match(workflow, /platform: macos-arm64-x64[\s\S]*arch_args: --arm64 --x64/);
  assert.equal((workflow.match(/target: mac/g) || []).length, 1);
  assert.match(workflow, /Expected signed arm64 and x64 TaskHandoff\.app bundles/);
});

test("desktop builds embed one Linux-container controlled-instance artifact assembled from native node-pty prebuilds", () => {
  for (const identity of ["linux-x64", "linux-arm64"]) {
    const [platform, arch] = identity.split("-");
    assert.match(workflow, new RegExp(`platform: ${platform}\\n\\s+arch: ${arch}`));
  }
  assert.doesNotMatch(workflow, /platform: (?:darwin|win32)/);
  assert.doesNotMatch(workflow, /Collect packaged node-pty prebuild/);
  assert.match(workflow, /node scripts\/node-pty-prebuild\.mjs build/);
  assert.match(workflow, /node:24-bullseye/);
  assert.match(workflow, /npm_config_nodedir=\/usr\/local/);
  assert.match(workflow, /pattern: desktop-node-pty-prebuild-\*/);
  assert.match(workflow, /controlled-instance-artifact:\n\s+name: Linux controlled instance artifact\n\s+needs: node-pty-prebuilds/);
  assert.equal((workflow.match(/pnpm runtime:artifact -- --version/g) || []).length, 1);
  assert.match(workflow, /--prebuilds-dir release\/node-pty-prebuilds/);
  assert.match(workflow, /build:\n\s+name: Build \$\{\{ matrix\.platform \}\}\n\s+needs: controlled-instance-artifact/);
  const download = workflow.indexOf("name: desktop-controlled-instance-runtime-${{ needs.controlled-instance-artifact.outputs.version }}");
  const prepare = workflow.indexOf("run: pnpm desktop:prepare");
  assert.ok(download >= 0 && download < prepare, "desktop build must download the runtime artifact before packaging");
  assert.match(workflow, /path: release\/runtime-artifacts/);
  assert.match(workflow, /run: pnpm desktop:prepare\n\s+env:\n\s+TASK_HANDOFF_VERSION: \$\{\{ steps\.version\.outputs\.value \}\}/);
});

test("desktop release notes present installers before generated changelog", () => {
  assert.match(workflow, /name: desktop-release-\$\{\{ matrix\.platform \}\}/);
  assert.match(workflow, /pattern: desktop-release-\*/);
  assert.doesNotMatch(workflow, /pattern: desktop-\*$/m);
  assert.match(workflow, /Compose user-facing release notes/);
  assert.match(workflow, /## Download TaskHandoff/);
  assert.match(workflow, /\| Platform \| Architecture \| Installer \|/);
  assert.match(workflow, /append_installers dmg macOS DMG/);
  assert.match(workflow, /append_installers exe Windows Installer/);
  assert.match(workflow, /append_installers AppImage Linux AppImage/);
  assert.match(workflow, /append_installers deb Linux DEB/);
  assert.match(workflow, /Automatic update files/);
  assert.match(workflow, /cat generated-release-notes\.md/);
  assert.equal((workflow.match(/--notes-file release-notes\.md/g) || []).length, 3);
  assert.doesNotMatch(workflow, /--generate-notes/);
});
