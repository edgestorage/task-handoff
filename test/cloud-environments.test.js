const assert = require("node:assert/strict");
const test = require("node:test");

const cloudEnvironments = require("../shared/cloud-environments.cjs");
const {
  cloudEnvironmentForServiceOrigin,
  configuredCloudEnvironmentVariables,
  isTrustedCloudRelayUrl,
  isTrustedCloudServiceOrigin,
  resolveCloudDiscovery,
  resolveCloudEnvironment,
} = cloudEnvironments;

const ENVIRONMENT = Object.freeze({
  TASK_HANDOFF_CLOUD_ENV: "production",
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://coordinator.example.test",
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "example.test, coordinator.test",
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "relay.test",
  TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: "1",
  TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: "_cloud.example.test",
  TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN: "https://fallback.example.test",
});

function resolve(overrides = {}) {
  return resolveCloudEnvironment("production", undefined, { ...ENVIRONMENT, ...overrides });
}

test("cloud environments contain no built-in production configuration", () => {
  assert.equal(cloudEnvironments.CLOUD_ENVIRONMENTS, undefined);
  assert.equal(cloudEnvironments.CLOUD_DISCOVERY, undefined);
  assert.deepEqual(resolveCloudEnvironment(undefined, undefined, {}), {
    id: "local",
    serviceOrigin: "http://127.0.0.1",
    coordinatorHostSuffixes: ["127.0.0.1"],
    relayHostSuffixes: ["127.0.0.1"],
    allowInsecureRelay: true,
  });
  assert.throws(() => resolveCloudEnvironment("production", undefined, {}), { code: "MISSING_CLOUD_ENVIRONMENT" });
});

test("cloud environments are resolved entirely from environment variables", () => {
  const resolved = resolve();
  assert.deepEqual(resolved, {
    id: "production",
    serviceOrigin: "https://coordinator.example.test",
    coordinatorHostSuffixes: ["example.test", "coordinator.test"],
    relayHostSuffixes: ["relay.test"],
    allowInsecureRelay: true,
  });
  assert.deepEqual(resolveCloudEnvironment(undefined, undefined, { ...ENVIRONMENT, TASK_HANDOFF_CLOUD_ENV: "" }), {
    ...resolved,
    id: "custom",
  });
});

test("configured cloud environments are captured for build artifacts", () => {
  assert.deepEqual(configuredCloudEnvironmentVariables({}), {});
  assert.deepEqual(configuredCloudEnvironmentVariables({
    ...ENVIRONMENT,
    UNRELATED: "ignored",
  }), ENVIRONMENT);
  assert.throws(() => configuredCloudEnvironmentVariables({
    TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: "_cloud.example.test",
  }), { code: "MISSING_CLOUD_ENVIRONMENT" });
  assert.throws(() => configuredCloudEnvironmentVariables({
    ...ENVIRONMENT,
    TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: "",
  }), { code: "MISSING_CLOUD_ENVIRONMENT" });
});

test("Coordinator trust follows only the configured main-domain suffixes", () => {
  const environment = resolve();
  assert.equal(isTrustedCloudServiceOrigin(environment, environment.serviceOrigin), true);
  assert.equal(isTrustedCloudServiceOrigin(environment, `${environment.serviceOrigin}/some/path`), true);
  assert.equal(isTrustedCloudServiceOrigin(environment, "https://coordinator.example.test"), true);
  assert.equal(isTrustedCloudServiceOrigin(environment, "https://backup.coordinator.test"), true);
  assert.equal(isTrustedCloudServiceOrigin(environment, "https://example.test.evil.test"), false);
  assert.equal(isTrustedCloudServiceOrigin(environment, "http://coordinator.example.test"), false);
  assert.equal(isTrustedCloudServiceOrigin(environment, "not a url"), false);
  assert.equal(isTrustedCloudServiceOrigin(environment, undefined), false);
});

test("Relay trust follows only the configured main-domain suffixes", () => {
  const environment = { ...resolve(), relayHosts: ["relay.outside.test"] };
  assert.equal(isTrustedCloudRelayUrl(environment, "wss://edge.relay.test/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(environment, "wss://relay.relay.test/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(environment, "wss://relay.outside.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(environment, "wss://coordinator.example.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(environment, "wss://relay.test.evil.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(environment, "ws://edge.relay.test/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(resolve({ TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: "0" }), "ws://edge.relay.test/connect"), false);
});

test("discovery endpoints reuse the Coordinator suffix allowlist", () => {
  const environment = resolve();
  assert.deepEqual(resolveCloudDiscovery(environment, ENVIRONMENT), {
    record: "_cloud.example.test",
    fallbackOrigin: "https://fallback.example.test",
    allowedHostSuffixes: ["example.test", "coordinator.test"],
  });
  assert.equal(isTrustedCloudServiceOrigin(environment, "https://outside.test"), false);
  assert.equal(resolveCloudDiscovery(environment, { ...ENVIRONMENT, TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: "" }), undefined);
  assert.throws(() => resolveCloudDiscovery(environment, {
    ...ENVIRONMENT,
    TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN: "https://outside.test",
  }), { code: "INVALID_CLOUD_ENVIRONMENT" });
});

test("ad-hoc cloud environments keep the isolated single-host behaviour", () => {
  const local = cloudEnvironmentForServiceOrigin("http://localhost:8080", {});
  assert.equal(local.serviceOrigin, "http://localhost:8080");
  assert.deepEqual(local.coordinatorHostSuffixes, ["localhost"]);
  assert.deepEqual(local.relayHostSuffixes, ["localhost"]);
  assert.equal(local.allowInsecureRelay, true);
  assert.equal(isTrustedCloudRelayUrl(local, "ws://localhost:8080/connect"), true);
  assert.equal(isTrustedCloudRelayUrl(local, "ws://attacker.example/connect"), false);

  const remote = cloudEnvironmentForServiceOrigin("https://preview.example.test", {});
  assert.equal(remote.allowInsecureRelay, false);
  assert.equal(isTrustedCloudRelayUrl(remote, "ws://preview.example.test/connect"), false);
  assert.equal(isTrustedCloudRelayUrl(remote, "wss://preview.example.test/connect"), true);
});

test("configured service origins resolve to the environment while other origins are isolated", () => {
  const environment = resolve();
  assert.deepEqual(cloudEnvironmentForServiceOrigin("https://coordinator.example.test", ENVIRONMENT), environment);
  assert.deepEqual(cloudEnvironmentForServiceOrigin("https://backup.example.test", ENVIRONMENT), environment);
  const custom = cloudEnvironmentForServiceOrigin("https://custom.example.test", {});
  assert.equal(custom.id, "custom");
  assert.deepEqual(custom.coordinatorHostSuffixes, ["custom.example.test"]);
});

test("invalid or incomplete cloud environment settings fail closed", () => {
  assert.throws(() => resolve({ TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "https://example.test" }), { code: "INVALID_CLOUD_ENVIRONMENT" });
  assert.throws(() => resolve({ TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: "sometimes" }), { code: "INVALID_CLOUD_ENVIRONMENT" });
  assert.throws(() => resolve({ TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "" }), { code: "MISSING_CLOUD_ENVIRONMENT" });
  assert.throws(() => resolve({ TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "" }), { code: "MISSING_CLOUD_ENVIRONMENT" });
});
