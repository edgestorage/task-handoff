import Constants from 'expo-constants';

export const isMobileTestMode = Constants.expoConfig?.extra?.variant === 'development';
export const isMobileStagingMode = Constants.expoConfig?.extra?.variant === 'staging';
export const mobileCloudServiceOrigin = typeof Constants.expoConfig?.extra?.cloudServiceOrigin === 'string' ? new URL(Constants.expoConfig.extra.cloudServiceOrigin).origin : undefined;

const configuredScheme = Array.isArray(Constants.expoConfig?.scheme) ? Constants.expoConfig.scheme[0] : Constants.expoConfig?.scheme;
export const mobileAppScheme = typeof configuredScheme === 'string' && configuredScheme.length > 0 ? configuredScheme : 'taskhandoff';

export type MobileFeatureFlag = 'officialAccount';

export function isMobileFeatureEnabled(flag: MobileFeatureFlag) {
  const flags = Constants.expoConfig?.extra?.featureFlags;
  if (flags && typeof flags === 'object' && typeof flags[flag] === 'boolean') return flags[flag];
  // Compatibility for v0.0.32: native manifests exposed only cloudRelayEnabled.
  if (flag === 'officialAccount') return Constants.expoConfig?.extra?.cloudRelayEnabled === true;
  return false;
}
