import Constants from 'expo-constants';

export const isMobileTestMode = Constants.expoConfig?.extra?.variant === 'development';
export const isMobileStagingMode = Constants.expoConfig?.extra?.variant === 'staging';
export const mobileStagingCloudOrigin = typeof Constants.expoConfig?.extra?.cloudServiceOrigin === 'string' ? new URL(Constants.expoConfig.extra.cloudServiceOrigin).origin : undefined;
export const isMobileCloudRelayEnabled = Constants.expoConfig?.extra?.cloudRelayEnabled !== false;
