import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';

import type { NativeAppleAuthentication } from './apple-authentication';

export async function nativeAppleAuthentication(): Promise<NativeAppleAuthentication | undefined> {
  if (!await AppleAuthentication.isAvailableAsync()) return undefined;
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  if (!bundleId) throw Object.assign(new Error('Apple sign-in is not configured for this app.'), { code: 'APPLE_NATIVE_CONFIGURATION_INVALID' });
  return {
    bundleId,
    async signIn({ state, nonce }) {
      try {
        return await AppleAuthentication.signInAsync({
          state, nonce,
          requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return undefined;
        throw error;
      }
    },
  };
}
