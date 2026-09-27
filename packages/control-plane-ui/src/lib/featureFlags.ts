export type FeatureFlag = "officialAccount" | "agentRuns";

declare const __TASK_HANDOFF_FEATURE_FLAGS__: Readonly<Record<FeatureFlag, boolean>>;

export function isFeatureEnabled(flag: FeatureFlag) {
  return __TASK_HANDOFF_FEATURE_FLAGS__[flag] === true;
}
