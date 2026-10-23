const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/mobile-release.yml"), "utf8");
const {
  isTrustedCloudRelayUrl,
  isTrustedCloudServiceOrigin,
  resolveCloudDiscovery,
  resolveCloudEnvironment,
} = require("../shared/cloud-environments.cjs");

function workflowEnvironment(source) {
  const environment = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^  (TASK_HANDOFF_[A-Z_]+):\s*(.+)$/);
    if (!match) continue;
    environment[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return environment;
}

test("mobile releases use the production variant and official thandoff cloud identity at workflow scope", () => {
  const environment = workflowEnvironment(workflow);
  assert.equal(environment.TASK_HANDOFF_MOBILE_VARIANT, "production");
  assert.equal(environment.TASK_HANDOFF_CLOUD_ENV, "production");
  assert.equal(environment.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN, "https://cloud.thandoff.com");
  assert.equal(environment.TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES, "thandoff.com,xpbox.cn,aaasu.com");
  assert.equal(environment.TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES, "thandoff.com,xpbox.cn,aaasu.com");
  assert.equal(environment.TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY, "0");
  assert.equal(environment.TASK_HANDOFF_CLOUD_DISCOVERY_RECORD, "_cloud.thandoff.com");
  assert.equal(environment.TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN, "https://cloud.thandoff.com");

  const production = resolveCloudEnvironment("production", undefined, environment);
  const discovery = resolveCloudDiscovery(production, environment);
  assert.equal(isTrustedCloudServiceOrigin(production, production.serviceOrigin), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.thandoff.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://sz1.relay.aaasu.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.outside.test/connect"), false);
  assert.equal(discovery.record, "_cloud.thandoff.com");
  assert.equal(discovery.fallbackOrigin, "https://cloud.thandoff.com");
});

test("mobile releases stamp the same GitHub run number into Expo, Gradle and Xcode", () => {
  assert.match(workflow, /build_number: \$\{\{ steps\.release\.outputs\.build_number \}\}/);
  assert.match(workflow, /set-release-version\.mjs "\$version" "\$GITHUB_RUN_NUMBER"/);
  assert.equal((workflow.match(/set-release-version\.mjs "\$RELEASE_VERSION" "\$RELEASE_BUILD_NUMBER"/g) || []).length, 2);
  assert.match(workflow, /-PtaskHandoffVersionCode="\$RELEASE_BUILD_NUMBER"/);
  assert.match(workflow, /build_number="\$RELEASE_BUILD_NUMBER"/);
  assert.match(workflow, /CURRENT_PROJECT_VERSION="\$build_number"/);
});

test("mobile artifacts are unpacked and validated before they are published", () => {
  const androidValidation = workflow.indexOf("name: Validate signed Android production artifact");
  const androidPublish = workflow.indexOf("name: Publish Android APK to GitHub Release");
  assert.ok(androidValidation >= 0 && androidValidation < androidPublish);
  assert.match(workflow, /"\$aapt2_path" dump badging "\$ARTIFACT"/);
  assert.match(workflow, /unzip -p "\$ARTIFACT" assets\/app\.config/);

  const iosValidation = workflow.indexOf("name: Validate signed iOS production artifact");
  const iosUpload = workflow.indexOf("name: Upload iOS application to App Store Connect");
  assert.ok(iosValidation >= 0 && iosValidation < iosUpload);
  assert.match(workflow, /unzip -q "\$IOS_IPA_PATH" -d "\$validation_dir"/);
  assert.match(workflow, /plutil -extract CFBundleVersion raw -o - "\$app_path\/Info\.plist"/);
  assert.match(workflow, /extension_build" != "\$RELEASE_BUILD_NUMBER"/);
  assert.match(workflow, /find "\$app_path" -type f -name app\.config/);
  assert.equal((workflow.match(/node apps\/mobile\/scripts\/check-release-manifest\.mjs/g) || []).length, 2);
});
