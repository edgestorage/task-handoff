import Constants from 'expo-constants';

export type MobileAppInfo = {
  name: string;
  version?: string;
  build?: string;
};

export function mobileAppInfoFromConstants(constants: typeof Constants = Constants): MobileAppInfo {
  const build = constants.platform?.ios?.buildNumber
    ?? (constants.platform?.android?.versionCode !== undefined ? String(constants.platform.android.versionCode) : undefined)
    ?? constants.expoConfig?.ios?.buildNumber
    ?? (constants.expoConfig?.android?.versionCode !== undefined ? String(constants.expoConfig.android.versionCode) : undefined);
  return {
    name: 'TaskHandoff',
    version: constants.expoConfig?.version,
    build,
  };
}

export const mobileAppInfo = mobileAppInfoFromConstants();
