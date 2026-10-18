const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CLOUD_DISCOVERY,
  CLOUD_ENVIRONMENTS,
  cloudEnvironmentForServiceOrigin,
  isTrustedCloudRelayUrl,
  isTrustedCloudServiceOrigin,
  resolveCloudEnvironment,
} = require("../shared/cloud-environments.cjs");

test("registered cloud environments declare their service origin and Relay hosts", () => {
  assert.deepEqual(Object.keys(CLOUD_ENVIRONMENTS).sort(), ["production", "staging"]);
  assert.equal(CLOUD_ENVIRONMENTS.production.serviceOrigin, "https://cloud.thandoff.com");
  assert.deepEqual(CLOUD_ENVIRONMENTS.production.relayHosts, [
    "relay.thandoff.com",
    "relay.th.xpbox.cn",
    "relay.aaasu.com",
  ]);
  assert.equal(CLOUD_ENVIRONMENTS.staging.serviceOrigin, "https://th.aaasu.com");
  assert.deepEqual(CLOUD_ENVIRONMENTS.staging.relayHosts, ["relay.aaasu.com"]);
  assert.equal(resolveCloudEnvironment(undefined), CLOUD_ENVIRONMENTS.production);
  assert.equal(resolveCloudEnvironment("staging"), CLOUD_ENVIRONMENTS.staging);
});

test("registered cloud environments declare their versioned plain-text discovery records", () => {
  assert.deepEqual(CLOUD_DISCOVERY.production, {
    record: "_cloud.thandoff.com",
    fallbackOrigin: "https://cloud.thandoff.com",
    allowedHostSuffixes: ["thandoff.com"],
  });
  assert.deepEqual(CLOUD_DISCOVERY.staging, {
    record: "_cloud.aaasu.com",
    fallbackOrigin: "https://th.aaasu.com",
    allowedHostSuffixes: ["aaasu.com"],
  });
});

test("unknown cloud environment identifiers fail closed instead of trusting any origin", () => {
  assert.throws(() => resolveCloudEnvironment("preview"), { code: "UNKNOWN_CLOUD_ENVIRONMENT" });
  assert.throws(() => resolveCloudEnvironment("preview", "staging"), { code: "UNKNOWN_CLOUD_ENVIRONMENT" });
  // An unset name is the documented default rather than an unknown environment.
  assert.equal(resolveCloudEnvironment(undefined), CLOUD_ENVIRONMENTS.production);
  assert.equal(resolveCloudEnvironment("  "), CLOUD_ENVIRONMENTS.production);
});

test("service origin trust is an exact origin match inside the selected environment", () => {
  const staging = CLOUD_ENVIRONMENTS.staging;
  assert.equal(isTrustedCloudServiceOrigin(staging, "https://th.aaasu.com"), true);
  assert.equal(isTrustedCloudServiceOrigin(staging, "https://th.aaasu.com/some/path"), true);
  assert.equal(isTrustedCloudServiceOrigin(staging, "https://cloud.thandoff.com"), false);
  assert.equal(isTrustedCloudServiceOrigin(staging, "https://th.aaasu.com.evil.test"), false);
  assert.equal(isTrustedCloudServiceOrigin(staging, "not a url"), false);
  assert.equal(isTrustedCloudServiceOrigin(staging, undefined), false);
});

test("Relay URL trust follows the environment Relay host allowlist", () => {
  const staging = CLOUD_ENVIRONMENTS.staging;
  const production = CLOUD_ENVIRONMENTS.production;
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://relay1.relay.aaasu.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://relay.aaasu.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://relay.thandoff.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.thandoff.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://hk.relay.thandoff.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.th.xpbox.cn/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://hk.relay.th.xpbox.cn/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.aaasu.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://hk.relay.aaasu.com/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.taskhandoff.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://relay.th.xpbox.cn.evil.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(production, "wss://evilrelay.th.xpbox.cn/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://evilrelay.aaasu.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://relay.aaasu.com.evil.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(staging, "wss://relay9.relay.example.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(staging, "ws://relay1.relay.aaasu.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(production, "http://relay.thandoff.com/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(production, "ws://relay.th.xpbox.cn/connect"), false);
});

test("ad-hoc cloud environments keep the isolated single-host behaviour", () => {
  const local = cloudEnvironmentForServiceOrigin("http://localhost:8080");
  assert.equal(local.serviceOrigin, "http://localhost:8080");
  assert.deepEqual(local.relayHosts, ["localhost"]);
  assert.equal(local.allowInsecureRelay, true);
  assert.equal(isTrustedCloudRelayUrl(local, "ws://localhost:8080/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(local, "ws://attacker.example/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(local, "wss://relay.thandoff.com/connect"), false);

  const remote = cloudEnvironmentForServiceOrigin("https://preview.example.test");
  assert.equal(remote.allowInsecureRelay, false);
  assert.equal(isTrustedCloudRelayUrl(remote, "ws://preview.example.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(remote, "wss://preview.example.test/connect"), true);
});
