import { z } from 'zod';
import { ControlPlanePublicCapabilitiesSchema } from '@task-handoff/protocol/control-plane-access';

export const MOBILE_CONTROL_PLANE_PROFILE_VERSION = 1;

export const MobileControlPlaneIdentitySchema = z.object({
  controlPlaneId: z.string().trim().min(1).max(160),
  publicKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  displayName: z.string().trim().min(1).max(160).optional(),
  protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const MobileControlPlaneCapabilitiesSchema = ControlPlanePublicCapabilitiesSchema;

export const MobileControlPlaneProfileSchema = z.object({
  version: z.literal(MOBILE_CONTROL_PLANE_PROFILE_VERSION),
  identity: MobileControlPlaneIdentitySchema,
  access: z.object({
    kind: z.literal('direct'),
    origin: z.string().url(),
    secureSessionKey: z.string().trim().min(1).max(160),
  }).strict(),
  capabilities: MobileControlPlaneCapabilitiesSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type MobileControlPlaneIdentity = z.infer<typeof MobileControlPlaneIdentitySchema>;
export type MobileControlPlaneCapabilities = z.infer<typeof MobileControlPlaneCapabilitiesSchema>;
export type MobileControlPlaneProfile = z.infer<typeof MobileControlPlaneProfileSchema>;

const STORED_PROFILE_FIELDS = {
  '': ['version', 'identity', 'access', 'capabilities', 'createdAt', 'updatedAt'],
  identity: ['controlPlaneId', 'publicKeyFingerprint', 'displayName', 'protocolVersion'],
  access: ['kind', 'origin', 'secureSessionKey'],
  capabilities: ['authentication', 'aiSessions', 'nodes', 'instanceBoard'],
} as const;

export function storedMobileControlPlaneProfileUnknownFields(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const source = input as Record<string, unknown>;
  const unknown: string[] = [];
  for (const [prefix, allowed] of Object.entries(STORED_PROFILE_FIELDS)) {
    const value = prefix ? source[prefix] : source;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!(allowed as readonly string[]).includes(key)) unknown.push(prefix ? `${prefix}.${key}` : key);
    }
  }
  return unknown.slice(0, 20);
}

function pick(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

export function sanitizeStoredMobileControlPlaneProfile(input: unknown) {
  const profile = pick(input, ['version', 'identity', 'access', 'capabilities', 'createdAt', 'updatedAt']);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
  const value = profile as Record<string, unknown>;
  return {
    ...value,
    identity: pick(value.identity, ['controlPlaneId', 'publicKeyFingerprint', 'displayName', 'protocolVersion']),
    access: pick(value.access, ['kind', 'origin', 'secureSessionKey']),
    capabilities: pick(value.capabilities, ['authentication', 'aiSessions', 'nodes', 'instanceBoard']),
  };
}

export function parseStoredMobileControlPlaneProfile(input: unknown) {
  return MobileControlPlaneProfileSchema.parse(sanitizeStoredMobileControlPlaneProfile(input));
}
