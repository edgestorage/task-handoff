import Constants from 'expo-constants';

export const isMobileTestMode = Constants.expoConfig?.extra?.variant === 'development';
