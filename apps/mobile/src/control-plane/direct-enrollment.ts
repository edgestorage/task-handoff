import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import {
  controlPlaneIdentitySigningInput,
  type ControlPlanePublicIdentityPayload,
} from '@task-handoff/protocol/control-plane-access';
import { createControlPlaneClient, type ControlPlaneClientTransport } from '@task-handoff/control-plane-client';

import type { SecureValueStore } from '../platform/secure-storage';
import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  type MobileControlPlaneProfile,
} from './profile';

const CLOCK_SKEW_MS = 60_000;
const DEVICE_ID_KEY = 'mobile-device-id';

export class DirectEnrollmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DirectEnrollmentError';
  }
}

export type VerifiedDirectControlPlane = {
  origin: string;
  identity: ControlPlanePublicIdentityPayload;
};

export function assertDirectIdentityCompatible(
  target: VerifiedDirectControlPlane,
  existingProfiles: readonly MobileControlPlaneProfile[],
) {
  const conflict = existingProfiles.find((profile) => (
    profile.access.origin === target.origin || profile.identity.controlPlaneId === target.identity.controlPlaneId
  ) && (
    profile.identity.controlPlaneId !== target.identity.controlPlaneId
      || profile.identity.publicKeyFingerprint !== target.identity.publicKey.fingerprint
  ));
  if (conflict) {
    throw new DirectEnrollmentError(
      'DIRECT_IDENTITY_CHANGED',
      'This address or Control Plane ID now presents a different signing identity. Review the server identity before reconnecting.',
    );
  }
}

export function existingDirectControlPlaneProfile(
  target: VerifiedDirectControlPlane,
  profiles: readonly MobileControlPlaneProfile[],
) {
  return profiles.find((profile) => profile.identity.controlPlaneId === target.identity.controlPlaneId
    && profile.identity.publicKeyFingerprint === target.identity.publicKey.fingerprint);
}

export async function mobileSessionStorageKey(identity: Pick<ControlPlanePublicIdentityPayload, 'controlPlaneId' | 'publicKey'>) {
  const controlPlaneDigest = nacl.hash(new TextEncoder().encode(identity.controlPlaneId)).slice(0, 32);
  return `session.${identity.publicKey.fingerprint.slice('sha256:'.length)}.${encodeBase64Url(controlPlaneDigest)}`;
}

export function normalizeDirectControlPlaneOrigin(input: string, options: { allowInsecureHttp?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new DirectEnrollmentError('DIRECT_ORIGIN_INVALID', 'Enter a valid Control Plane URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DirectEnrollmentError('DIRECT_ORIGIN_COMPONENTS_FORBIDDEN', 'The Control Plane address cannot contain credentials, query parameters, or a fragment.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new DirectEnrollmentError('DIRECT_ORIGIN_PATH_FORBIDDEN', 'Enter the Control Plane origin without an API or page path.');
  }
  const insecureHttp = options.allowInsecureHttp && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !insecureHttp) {
    throw new DirectEnrollmentError('DIRECT_HTTPS_REQUIRED', 'A production Control Plane address must use HTTPS.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DirectEnrollmentError('DIRECT_SCHEME_INVALID', 'The Control Plane address must use HTTPS.');
  }
  return url.origin;
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = globalThis.atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function verifyIdentity(payload: ControlPlanePublicIdentityPayload, signature: string, now: number) {
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= now || expiresAt <= issuedAt) {
    throw new DirectEnrollmentError('DIRECT_IDENTITY_STALE', 'The Control Plane identity response is expired or has an invalid clock.');
  }
  const publicKey = decodeBase64Url(payload.publicKey.value);
  const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, publicKey));
  if (`sha256:${encodeBase64Url(digest)}` !== payload.publicKey.fingerprint) {
    throw new DirectEnrollmentError('DIRECT_IDENTITY_FINGERPRINT_INVALID', 'The Control Plane public key fingerprint is invalid.');
  }
  const message = new TextEncoder().encode(controlPlaneIdentitySigningInput(payload));
  if (!nacl.sign.detached.verify(message, decodeBase64Url(signature), publicKey)) {
    throw new DirectEnrollmentError('DIRECT_IDENTITY_SIGNATURE_INVALID', 'The Control Plane identity signature is invalid.');
  }
}

function publicAuthApi(origin: string, fetchImpl: typeof fetch) {
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new DirectEnrollmentError('DIRECT_CROSS_ORIGIN_FORBIDDEN', 'Enrollment requests must remain on the verified origin.');
      let response: Response;
      try {
        response = await fetchImpl(url.toString(), { ...init, credentials: 'omit', redirect: 'error' });
      } catch {
        throw new DirectEnrollmentError('DIRECT_TLS_OR_NETWORK_FAILED', 'Could not connect to the Control Plane.', true);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DirectEnrollmentError('DIRECT_RESPONSE_INVALID', 'The target did not return a valid Control Plane response.', false, response.status);
      }
      if (!response.ok) {
        const error = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: string; message?: string } }).error : undefined;
        throw new DirectEnrollmentError(error?.code || 'DIRECT_HTTP_ERROR', error?.message || `Control Plane request failed with HTTP ${response.status}.`, response.status >= 500, response.status);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new DirectEnrollmentError('DIRECT_TARGET_NOT_CONTROL_PLANE', 'The target did not return the expected Control Plane response.');
      return parsed.data;
    },
  };
  return createControlPlaneClient(transport).auth;
}

export async function probeDirectControlPlane(
  input: string,
  options: { allowInsecureHttp?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<VerifiedDirectControlPlane> {
  const origin = normalizeDirectControlPlaneOrigin(input, options);
  let document;
  try {
    document = await publicAuthApi(origin, options.fetchImpl ?? fetch).identity();
  } catch (cause) {
    if (cause instanceof DirectEnrollmentError) throw cause;
    throw new DirectEnrollmentError('DIRECT_TLS_OR_NETWORK_FAILED', 'Could not connect to the Control Plane.', true);
  }
  await verifyIdentity(document.data.payload, document.data.signature, options.now ?? Date.now());
  return { origin, identity: document.data.payload };
}

async function mobileDevice(secureStore: SecureValueStore) {
  let id = await secureStore.get(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await secureStore.set(DEVICE_ID_KEY, id);
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  return { id, name: `TaskHandoff on ${platform === 'ios' ? 'iOS' : 'Android'}`, platform } as const;
}

export async function loginDirectControlPlane(
  target: VerifiedDirectControlPlane,
  credentials: { username: string; password: string },
  secureStore: SecureValueStore,
  options: { fetchImpl?: typeof fetch; now?: () => string } = {},
): Promise<MobileControlPlaneProfile> {
  if (target.identity.capabilities.authentication !== 'required') {
    throw new DirectEnrollmentError('DIRECT_AUTH_REQUIRED', 'Enable authentication on the Control Plane before adding it remotely.');
  }
  let login;
  try {
    login = await publicAuthApi(target.origin, options.fetchImpl ?? fetch).loginMobile({
      ...credentials,
      device: await mobileDevice(secureStore),
    });
  } catch (cause) {
    if (cause instanceof DirectEnrollmentError) throw cause;
    throw new DirectEnrollmentError('DIRECT_LOGIN_NETWORK_FAILED', 'The verified Control Plane could not be reached for sign-in.', true);
  }
  const secureSessionKey = await mobileSessionStorageKey(target.identity);
  await secureStore.set(secureSessionKey, login.sessionToken);
  const timestamp = options.now?.() ?? new Date().toISOString();
  return {
    version: MOBILE_CONTROL_PLANE_PROFILE_VERSION,
    identity: {
      controlPlaneId: target.identity.controlPlaneId,
      publicKeyFingerprint: target.identity.publicKey.fingerprint,
      protocolVersion: target.identity.protocolVersion,
    },
    access: { kind: 'direct', origin: target.origin, secureSessionKey },
    capabilities: target.identity.capabilities,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
