const FEATURE_FLAG_DEFINITIONS = Object.freeze({
  officialAccount: Object.freeze({
    environmentVariable: "TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED",
    // Compatibility for v0.0.32: mobile releases used the relay-specific name.
    legacyEnvironmentVariable: "TASK_HANDOFF_CLOUD_RELAY_ENABLED",
  }),
});

function resolveFeatureFlags(environment = process.env) {
  return Object.freeze(Object.fromEntries(Object.entries(FEATURE_FLAG_DEFINITIONS).map(([name, definition]) => {
    const configured = environment[definition.environmentVariable]
      ?? environment[definition.legacyEnvironmentVariable];
    return [name, configured === "1"];
  })));
}

module.exports = {
  FEATURE_FLAG_DEFINITIONS,
  resolveFeatureFlags,
};
