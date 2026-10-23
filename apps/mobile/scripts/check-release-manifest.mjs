import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifestPath = process.argv[2];
assert.ok(manifestPath, 'Expected the path to an embedded Expo app.config manifest.');

const config = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const releaseVersion = requiredEnvironment('RELEASE_VERSION');
const releaseBuildNumber = requiredEnvironment('RELEASE_BUILD_NUMBER');
const cloudEnvironment = requiredEnvironment('TASK_HANDOFF_CLOUD_ENV');
const serviceOrigin = requiredEnvironment('TASK_HANDOFF_CLOUD_SERVICE_ORIGIN');
const coordinatorSuffixes = requiredList('TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES');
const relaySuffixes = requiredList('TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES');
const discoveryRecord = requiredEnvironment('TASK_HANDOFF_CLOUD_DISCOVERY_RECORD');
const discoveryFallbackOrigin = requiredEnvironment('TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN');
const allowInsecureRelay = requiredEnvironment('TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY') === '1';
const numericBuildNumber = Number(releaseBuildNumber);

assert.match(releaseBuildNumber, /^[1-9]\d*$/, `Invalid release build number: ${releaseBuildNumber}`);
assert.equal(config.name, 'TaskHandoff', `Unexpected app name: ${config.name}`);
assert.equal(config.scheme, 'taskhandoff', `Unexpected app scheme: ${config.scheme}`);
assert.equal(config.version, releaseVersion, `Unexpected app version: ${config.version}`);
assert.equal(config.ios?.bundleIdentifier, 'com.taskhandoff.mobile', `Unexpected iOS bundle identifier: ${config.ios?.bundleIdentifier}`);
assert.equal(config.android?.package, 'com.taskhandoff.mobile', `Unexpected Android package: ${config.android?.package}`);
assert.equal(config.ios?.buildNumber, releaseBuildNumber, `Unexpected iOS build number: ${config.ios?.buildNumber}`);
assert.equal(config.android?.versionCode, numericBuildNumber, `Unexpected Android version code: ${config.android?.versionCode}`);
assert.equal(config.android?.usesCleartextTraffic, false, 'Production Android builds must reject cleartext traffic.');
assert.equal(config.extra?.variant, 'production', `Unexpected mobile build variant: ${config.extra?.variant}`);
if (process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED !== undefined) {
  const expectedOfficialAccount = process.env.TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED === '1';
  assert.equal(config.extra?.featureFlags?.officialAccount, expectedOfficialAccount, `Unexpected official account feature state: ${config.extra?.featureFlags?.officialAccount}`);
}

const embeddedCloud = config.extra?.cloudEnvironment;
assert.ok(embeddedCloud, 'The embedded Expo manifest has no cloud environment.');
assert.equal(embeddedCloud.id, cloudEnvironment, `Unexpected cloud environment: ${embeddedCloud.id}`);
assert.equal(embeddedCloud.serviceOrigin, serviceOrigin, `Unexpected cloud service origin: ${embeddedCloud.serviceOrigin}`);
assert.deepEqual(embeddedCloud.coordinatorHostSuffixes, coordinatorSuffixes, 'Unexpected Coordinator host suffixes.');
assert.deepEqual(embeddedCloud.relayHostSuffixes, relaySuffixes, 'Unexpected Relay host suffixes.');
assert.equal(embeddedCloud.allowInsecureRelay, allowInsecureRelay, `Unexpected insecure Relay setting: ${embeddedCloud.allowInsecureRelay}`);

const embeddedDiscovery = config.extra?.cloudDiscovery;
assert.ok(embeddedDiscovery, 'The embedded Expo manifest has no cloud discovery configuration.');
assert.equal(embeddedDiscovery.record, discoveryRecord, `Unexpected cloud discovery record: ${embeddedDiscovery.record}`);
assert.equal(embeddedDiscovery.fallbackOrigin, discoveryFallbackOrigin, `Unexpected cloud discovery fallback: ${embeddedDiscovery.fallbackOrigin}`);
assert.deepEqual(embeddedDiscovery.allowedHostSuffixes, coordinatorSuffixes, 'Unexpected cloud discovery host suffixes.');

console.log(`Validated production release manifest ${releaseVersion} (${releaseBuildNumber}) for ${serviceOrigin}.`);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `Missing required environment variable: ${name}`);
  return value;
}

function requiredList(name) {
  return requiredEnvironment(name).split(',').map((value) => value.trim()).filter(Boolean);
}
