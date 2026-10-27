import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import {
  CLOUD_DEVICE_AUTH_MAX_DEVICE_NAME_LENGTH,
  CLOUD_DEVICE_AUTH_MAX_VERSION_LENGTH,
  CloudDeviceDescriptorSchema,
  cloudDeviceComparisonCodeInput,
  cloudDeviceFingerprintInput,
  formatCloudDeviceComparisonCode,
  type CloudDeviceDescriptor,
} from '@task-handoff/cloud-contracts/mobile';

import type { SecureValueStore } from '../platform/secure-storage';

const DEVICE_ID_KEY = 'mobile-device-id';

export type MobileDeviceIdentity = Readonly<{
  id: string;
  descriptor: CloudDeviceDescriptor;
}>;

export async function mobileDeviceIdentity(secureStore: SecureValueStore): Promise<MobileDeviceIdentity> {
  let id = await secureStore.get(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await secureStore.set(DEVICE_ID_KEY, id);
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const version = optionalToken(Constants.expoConfig?.version, CLOUD_DEVICE_AUTH_MAX_VERSION_LENGTH);
  const fallbackName = `TaskHandoff on ${platform === 'ios' ? 'iOS' : 'Android'}`;
  return {
    id,
    descriptor: CloudDeviceDescriptorSchema.parse({
      name: deviceDisplayName(Constants.deviceName) ?? fallbackName,
      kind: 'mobile',
      platform,
      ...(version ? { version } : {}),
    }),
  };
}

export function deviceDisplayName(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  let truncated = '';
  for (const character of normalized) {
    if (truncated.length + character.length > CLOUD_DEVICE_AUTH_MAX_DEVICE_NAME_LENGTH) break;
    truncated += character;
  }
  return truncated.trim() || undefined;
}

export async function fingerprintDevicePublicKey(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(cloudDeviceFingerprintInput(publicKey))));
  return `sha256:${base64Url(digest)}`;
}

export async function deviceComparisonCode(bindingId: string, publicKey: string): Promise<string> {
  const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(cloudDeviceComparisonCodeInput(bindingId, publicKey))));
  return formatCloudDeviceComparisonCode(digest);
}

function optionalToken(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximum ? value.trim() : undefined;
}

function base64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
