import { z } from 'zod';
import {
  ControlPlanePublicCapabilitiesSchema,
  type ControlPlanePublicCapabilities,
} from '@task-handoff/protocol/control-plane-access';

export const MOBILE_CONTROL_PLANE_PROFILE_VERSION = 1;

export const MobileControlPlaneIdentitySchema = z.object({
  controlPlaneId: z.string().trim().min(1).max(160),
  publicKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  displayName: z.string().trim().min(1).max(160).optional(),
  protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const MobileControlPlaneCapabilitiesSchema = ControlPlanePublicCapabilitiesSchema.extend({
  triggers: z.boolean(),
}).strict();

const MobileControlPlaneProfileBaseSchema = z.object({
  version: z.literal(MOBILE_CONTROL_PLANE_PROFILE_VERSION),
  identity: MobileControlPlaneIdentitySchema,
  capabilities: MobileControlPlaneCapabilitiesSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const MobileDirectAccessSchema = z.object({
    kind: z.literal('direct'),
    origin: z.string().url(),
    secureSessionKey: z.string().trim().min(1).max(160),
}).strict();

const MobileCloudRelayAccessSchema = z.object({
  kind: z.literal('cloud-relay'),
  serviceOrigin: z.string().url(),
  bindingId: z.string().trim().min(1).max(160),
  bindingRevision: z.number().int().positive(),
  accountSession: z.object({
    id: z.string().trim().min(1).max(160),
    secureCredentialKey: z.string().trim().min(1).max(160),
  }).strict(),
  transport: z.object({
    request: z.boolean(),
    stream: z.boolean(),
    webSocket: z.boolean(),
  }).strict(),
}).strict();

export const MobileDirectControlPlaneProfileSchema = MobileControlPlaneProfileBaseSchema.extend({ access: MobileDirectAccessSchema }).strict();
export const MobileCloudRelayControlPlaneProfileSchema = MobileControlPlaneProfileBaseSchema.extend({ access: MobileCloudRelayAccessSchema }).strict();
export const MobileControlPlaneProfileSchema = MobileControlPlaneProfileBaseSchema.extend({
  access: z.discriminatedUnion('kind', [MobileDirectAccessSchema, MobileCloudRelayAccessSchema]),
}).strict();

export type MobileControlPlaneIdentity = z.infer<typeof MobileControlPlaneIdentitySchema>;
export type MobileControlPlaneCapabilities = z.infer<typeof MobileControlPlaneCapabilitiesSchema>;
export type MobileDirectControlPlaneProfile = z.infer<typeof MobileDirectControlPlaneProfileSchema>;
export type MobileCloudRelayControlPlaneProfile = z.infer<typeof MobileCloudRelayControlPlaneProfileSchema>;
export type MobileControlPlaneProfile = z.infer<typeof MobileControlPlaneProfileSchema>;

export function isDirectMobileControlPlaneProfile(profile: MobileControlPlaneProfile): profile is MobileDirectControlPlaneProfile {
  return profile.access.kind === 'direct';
}

export function mobileControlPlaneProfileAddress(profile: MobileControlPlaneProfile) {
  return profile.access.kind === 'direct' ? profile.access.origin : profile.access.serviceOrigin;
}

export function normalizeMobileControlPlaneCapabilities(input: ControlPlanePublicCapabilities): MobileControlPlaneCapabilities {
  return MobileControlPlaneCapabilitiesSchema.parse({
    ...input,
    triggers: input.triggers === true,
  });
}

const STORED_PROFILE_FIELDS = {
  '': ['version', 'identity', 'access', 'capabilities', 'createdAt', 'updatedAt'],
  identity: ['controlPlaneId', 'publicKeyFingerprint', 'displayName', 'protocolVersion'],
  access: ['kind', 'origin', 'secureSessionKey', 'serviceOrigin', 'bindingId', 'bindingRevision', 'accountSession', 'transport'],
  'access.accountSession': ['id', 'secureCredentialKey'],
  'access.transport': ['request', 'stream', 'webSocket'],
  capabilities: ['authentication', 'aiSessions', 'nodes', 'instanceBoard', 'triggers'],
} as const;

export function storedMobileControlPlaneProfileUnknownFields(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const source = input as Record<string, unknown>;
  const unknown: string[] = [];
  for (const [prefix, allowed] of Object.entries(STORED_PROFILE_FIELDS)) {
    const value = prefix ? nestedValue(source, prefix) : source;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!(allowed as readonly string[]).includes(key)) unknown.push(prefix ? `${prefix}.${key}` : key);
    }
  }
  return unknown.slice(0, 20);
}

function nestedValue(source: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
  ), source);
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
  const capabilities = pick(value.capabilities, ['authentication', 'aiSessions', 'nodes', 'instanceBoard', 'triggers']);
  const access = pick(value.access, ['kind', 'origin', 'secureSessionKey', 'serviceOrigin', 'bindingId', 'bindingRevision', 'accountSession', 'transport']);
  const accessRecord = access && typeof access === 'object' && !Array.isArray(access) ? access as Record<string, unknown> : undefined;
  const sanitizedAccess = accessRecord
    ? {
        ...accessRecord,
        ...(accessRecord.kind === 'cloud-relay' ? {
          accountSession: pick(accessRecord.accountSession, ['id', 'secureCredentialKey']),
          transport: pick(accessRecord.transport, ['request', 'stream', 'webSocket']),
        } : {}),
      }
    : access;
  return {
    ...value,
    // Compatibility for v0.0.19: its v1 direct profile remains valid unchanged.
    version: value.version,
    identity: pick(value.identity, ['controlPlaneId', 'publicKeyFingerprint', 'displayName', 'protocolVersion']),
    access: sanitizedAccess,
    capabilities: capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
      ? { triggers: false, ...capabilities }
      : capabilities,
  };
}

export function parseStoredMobileControlPlaneProfile(input: unknown) {
  return MobileControlPlaneProfileSchema.parse(sanitizeStoredMobileControlPlaneProfile(input));
}
