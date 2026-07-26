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

test("desktop release notes present installers before generated changelog", () => {
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
