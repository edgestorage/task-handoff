const assert = require("node:assert/strict");
const test = require("node:test");

const { FEATURE_FLAG_DEFINITIONS, resolveFeatureFlags } = require("../shared/feature-flags.cjs");

test("feature flags are disabled unless explicitly enabled", () => {
  assert.deepEqual(resolveFeatureFlags({}), { officialAccount: false });
  assert.deepEqual(resolveFeatureFlags({ TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "1" }), { officialAccount: true });
  assert.deepEqual(resolveFeatureFlags({ TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "true" }), { officialAccount: false });
});

test("the canonical official account flag takes precedence over the v0.0.32 alias", () => {
  assert.equal(FEATURE_FLAG_DEFINITIONS.officialAccount.environmentVariable, "TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED");
  assert.deepEqual(resolveFeatureFlags({ TASK_HANDOFF_CLOUD_RELAY_ENABLED: "1" }), { officialAccount: true });
  assert.deepEqual(resolveFeatureFlags({
    TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "0",
    TASK_HANDOFF_CLOUD_RELAY_ENABLED: "1",
  }), { officialAccount: false });
});
