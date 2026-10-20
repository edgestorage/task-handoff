const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/desktop-release.yml"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const prepareDesktopRuntime = fs.readFileSync(path.join(root, "scripts", "prepare-desktop-runtime.mjs"), "utf8");
const {
  isTrustedCloudRelayUrl,
  isTrustedCloudServiceOrigin,
  resolveCloudDiscovery,
  resolveCloudEnvironment,
} = require("../shared/cloud-environments.cjs");

function workflowCloudEnvironment(source) {
  const environment = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^  (TASK_HANDOFF_CLOUD_[A-Z_]+):\s*(.+)$/);
    if (!match) continue;
    environment[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return environment;
}

test("desktop releases build the shared official account feature flag into the UI", () => {
  assert.match(workflow, /TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: \$\{\{ vars\.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED \|\| vars\.TASK_HANDOFF_CLOUD_RELAY_ENABLED \|\| '1' \}\}/);
  assert.match(workflow, /TASK_HANDOFF_AGENT_RUNS_ENABLED: \$\{\{ vars\.TASK_HANDOFF_AGENT_RUNS_ENABLED \|\| '0' \}\}/);
  // Built-in project content is materialized during `desktop:prepare`, so the
  // release workflow owns the rollout switch for the shipped folder.
  assert.match(workflow, /TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED: \$\{\{ vars\.TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED \|\| '0' \}\}/);
});

test("mobile releases default the official account feature flag on", () => {
  const mobileWorkflow = fs.readFileSync(path.join(root, ".github/workflows/mobile-release.yml"), "utf8");
  assert.match(mobileWorkflow, /TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: \$\{\{ vars\.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED \|\| vars\.TASK_HANDOFF_CLOUD_RELAY_ENABLED \|\| '1' \}\}/);
});

test("runtime releases default the official account feature flag on", () => {
  const runtimeWorkflow = fs.readFileSync(path.join(root, ".github/workflows/runtime-release.yml"), "utf8");
  assert.match(runtimeWorkflow, /TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: \$\{\{ vars\.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED \|\| '1' \}\}/);
});

test("desktop releases materialize the image market public key into the packaged app", () => {
  assert.match(workflow, /TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY: \$\{\{ vars\.TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY \}\}/);
  assert.match(manifest.scripts["desktop:prepare"], /node scripts\/prepare-desktop-market-key\.mjs$/);
  assert.deepEqual(
    manifest.build.extraResources.filter((entry) => String(entry.to).includes("market-catalog-public-key")),
    [{ from: "build/market-catalog-public-key.txt", to: "market-catalog-public-key.txt" }],
  );
});

test("desktop releases bake the production cloud identity into packaged resources", () => {
  const environment = workflowCloudEnvironment(workflow);
  const expectedNames = [
    "TASK_HANDOFF_CLOUD_ENV",
    "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN",
    "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES",
    "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES",
    "TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY",
    "TASK_HANDOFF_CLOUD_DISCOVERY_RECORD",
    "TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN",
  ];
  assert.deepEqual(Object.keys(environment).sort(), [...expectedNames].sort());
  for (const name of expectedNames) assert.ok(environment[name], `desktop release must define ${name}`);

  const production = resolveCloudEnvironment("production", undefined, environment);
  assert.equal(production.id, "production");
  assert.equal(isTrustedCloudServiceOrigin(production, production.serviceOrigin), true);
  assert.equal(isTrustedCloudRelayUrl(production, `wss://edge.${production.relayHostSuffixes[0]}/connect`), true);
  assert.match(manifest.scripts["desktop:prepare"], /node scripts\/prepare-cloud-environment\.mjs --out build\/desktop-cloud-environment\.cjs/);
  assert.ok(manifest.build.files.includes("build/desktop-cloud-environment.cjs"));
  assert.equal(manifest.build.extraResources.some((entry) => String(entry.to).includes("cloud-environment")), false);
});

test("mobile releases pass the Agent Runs build flag through to Expo", () => {
  const mobileWorkflow = fs.readFileSync(path.join(root, ".github/workflows/mobile-release.yml"), "utf8");
  assert.match(mobileWorkflow, /TASK_HANDOFF_AGENT_RUNS_ENABLED: \$\{\{ vars\.TASK_HANDOFF_AGENT_RUNS_ENABLED \|\| '0' \}\}/);
});

test("mobile releases bake the production cloud identity from workflow environment variables", () => {
  const mobileWorkflow = fs.readFileSync(path.join(root, ".github/workflows/mobile-release.yml"), "utf8");
  const environment = workflowCloudEnvironment(mobileWorkflow);
  const expectedNames = [
    "TASK_HANDOFF_CLOUD_ENV",
    "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN",
    "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES",
    "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES",
    "TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY",
    "TASK_HANDOFF_CLOUD_DISCOVERY_RECORD",
    "TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN",
  ];
  assert.deepEqual(Object.keys(environment).sort(), [...expectedNames].sort());
  for (const name of expectedNames) assert.ok(environment[name], `mobile release must define ${name}`);

  const production = resolveCloudEnvironment("production", undefined, environment);
  const discovery = resolveCloudDiscovery(production, environment);
  assert.equal(production.id, "production");
  assert.equal(isTrustedCloudServiceOrigin(production, production.serviceOrigin), true);
  assert.equal(isTrustedCloudRelayUrl(production, `wss://edge.${production.relayHostSuffixes[0]}/connect`), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.outside.test/connect"), false);
  assert.equal(discovery.fallbackOrigin, production.serviceOrigin);
  assert.deepEqual(discovery.allowedHostSuffixes, production.coordinatorHostSuffixes);
});

test("local desktop runtime preparation follows the controlled-instance package version", () => {
  assert.match(prepareDesktopRuntime, /path\.join\(root, "packages", "controlled-instance", "package\.json"\)/);
  assert.match(prepareDesktopRuntime, /process\.env\.TASK_HANDOFF_VERSION \|\| controlledInstancePackage\.version/);
  assert.match(prepareDesktopRuntime, /env: \{ \.\.\.process\.env, TASK_HANDOFF_VERSION: version \}/);
  assert.doesNotMatch(prepareDesktopRuntime, /rootPackage\.version/);
});

test("desktop development rebuilds the local CLI before starting Electron", () => {
  const start = manifest.scripts["desktop:start"];
  assert.match(start, /^pnpm run build:legacy && pnpm run desktop:runtime:prepare/);
  assert.match(start, /pnpm --filter @task-handoff\/desktop-shell start$/);
});

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

test("Windows updater metadata is generated from one dual-architecture build", () => {
  // Two separate Windows jobs would each write `latest.yml` and the merged release
  // assets would silently drop one architecture, so both arches build together.
  assert.match(workflow, /platform: windows-x64-arm64[\s\S]*arch_args: --x64 --arm64/);
  assert.equal((workflow.match(/platform: windows-/g) || []).length, 1);
  assert.equal((workflow.match(/target: win\b/g) || []).length, 1);
  assert.match(workflow, /platform: linux-x64[\s\S]*arch_args: --x64/);
});

test("release notes label arm64 installers per platform", () => {
  assert.match(workflow, /architecture="Apple Silicon"/);
  assert.match(workflow, /else\n\s+architecture="arm64"/);
  // The dual-architecture Windows build also emits one installer without an
  // architecture token, which installs either architecture.
  assert.match(workflow, /elif \[\[ "\$platform" == "Windows" \]\]; then\n(?:\s+#[^\n]*\n)*\s+architecture="x64 \+ arm64"/);
  assert.match(workflow, /append_installers exe Windows Installer/);
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
