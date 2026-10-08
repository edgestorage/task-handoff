const assert = require("node:assert/strict");
const test = require("node:test");

const { FEATURE_FLAG_DEFINITIONS, resolveFeatureFlags } = require("../shared/feature-flags.cjs");

test("feature flags are disabled unless explicitly enabled", () => {
  assert.deepEqual(resolveFeatureFlags({}), { officialAccount: false, agentRuns: false, builtinProjects: false });
  assert.deepEqual(
    resolveFeatureFlags({ TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "1" }),
    { officialAccount: true, agentRuns: false, builtinProjects: false },
  );
  assert.deepEqual(
    resolveFeatureFlags({ TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "true" }),
    { officialAccount: false, agentRuns: false, builtinProjects: false },
  );
});

test("the canonical official account flag takes precedence over the v0.0.32 alias", () => {
  assert.equal(FEATURE_FLAG_DEFINITIONS.officialAccount.environmentVariable, "TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED");
  assert.deepEqual(
    resolveFeatureFlags({ TASK_HANDOFF_CLOUD_RELAY_ENABLED: "1" }),
    { officialAccount: true, agentRuns: false, builtinProjects: false },
  );
  assert.deepEqual(resolveFeatureFlags({
    TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "0",
    TASK_HANDOFF_CLOUD_RELAY_ENABLED: "1",
  }), { officialAccount: false, agentRuns: false, builtinProjects: false });
});

test("agent runs are gated by their own flag and stay off by default", () => {
  assert.equal(FEATURE_FLAG_DEFINITIONS.agentRuns.environmentVariable, "TASK_HANDOFF_AGENT_RUNS_ENABLED");
  assert.equal(FEATURE_FLAG_DEFINITIONS.agentRuns.legacyEnvironmentVariable, undefined);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_AGENT_RUNS_ENABLED: "1" }).agentRuns, true);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_AGENT_RUNS_ENABLED: "true" }).agentRuns, false);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_OFFICIAL_ACCOUNT_ENABLED: "1" }).agentRuns, false);
});

test("built-in projects are gated by their own flag and stay off by default", () => {
  assert.equal(FEATURE_FLAG_DEFINITIONS.builtinProjects.environmentVariable, "TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED");
  assert.equal(FEATURE_FLAG_DEFINITIONS.builtinProjects.legacyEnvironmentVariable, undefined);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED: "1" }).builtinProjects, true);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED: "true" }).builtinProjects, false);
  assert.equal(resolveFeatureFlags({ TASK_HANDOFF_AGENT_RUNS_ENABLED: "1" }).builtinProjects, false);
});
