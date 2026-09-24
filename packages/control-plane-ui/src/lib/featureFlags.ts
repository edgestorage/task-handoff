export type FeatureFlag = "officialAccount";

declare const __TASK_HANDOFF_FEATURE_FLAGS__: Readonly<Record<FeatureFlag, boolean>>;

export function isFeatureEnabled(flag: FeatureFlag) {
  return __TASK_HANDOFF_FEATURE_FLAGS__[flag] === true;
}
