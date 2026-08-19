import {
  ControlPlaneProxyErrorSchema,
  PublicProxyBindingSchema,
  PublicProxyInviteSchema,
  type PublicProxyBinding,
  type PublicProxyInvite,
} from "@task-handoff/protocol/control-plane-proxy";
import { z } from "zod";

export const ProxyBindingRecordSchema = PublicProxyBindingSchema.extend({
  credentialHash: z.string().trim().min(32).max(256),
}).strict();

export type ProxyBindingRecord = z.infer<typeof ProxyBindingRecordSchema>;

export type ProxyInviteRecord = PublicProxyInvite & { tokenHash: string };

export const ControlPlaneProxyAuthoritySchema = z.object({
  revision: z.number().int().nonnegative(),
  // Compatibility for v0.0.21: retain the empty property so an N-1 process can
  // read the authority file, but never persist ephemeral invite material.
  invites: z.array(z.unknown()).length(0).default([]),
  bindings: z.array(ProxyBindingRecordSchema),
}).strict();

export type ControlPlaneProxyAuthority = z.infer<typeof ControlPlaneProxyAuthoritySchema>;

const recordKeys = {
  binding: new Set(Object.keys(ProxyBindingRecordSchema.shape)),
};

function pick(input: unknown, keys: Iterable<string>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries([...keys].filter((key) => key in source).map((key) => [key, source[key]]));
}

export function sanitizeStoredProxyRecord(
  kind: "binding",
  input: unknown,
  onWarning?: (warning: { kind: string; fields: string[] }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const keys = recordKeys[kind];
  const unknown = Object.keys(source).filter((key) => !keys.has(key));
  if (unknown.length > 0) onWarning?.({ kind, fields: unknown });
  const value = pick(source, keys) as Record<string, unknown>;
  if (value.lastError) {
    value.lastError = pick(value.lastError, Object.keys(ControlPlaneProxyErrorSchema.shape));
  }
  return value;
}

export function sanitizeStoredProxyAuthority(
  input: unknown,
  onWarning?: (warning: { kind: string; fields: string[] }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const authorityKeys = new Set(["revision", "invites", "bindings"]);
  const unknown = Object.keys(source).filter((key) => !authorityKeys.has(key));
  if (unknown.length > 0) onWarning?.({ kind: "authority", fields: unknown });
  return {
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    invites: [],
    bindings: Array.isArray(source.bindings)
      ? source.bindings
        .map((value) => sanitizeStoredProxyRecord("binding", value, onWarning))
        .filter((value) => !value || typeof value !== "object" || (value as Record<string, unknown>).status !== "revoked")
      : source.bindings,
  };
}

export function publicProxyInvite(invite: ProxyInviteRecord): PublicProxyInvite {
  const { tokenHash: _tokenHash, ...value } = invite;
  return PublicProxyInviteSchema.parse(value);
}

export function publicProxyBinding(binding: ProxyBindingRecord): PublicProxyBinding {
  const { credentialHash: _credentialHash, ...value } = binding;
  return PublicProxyBindingSchema.parse(value);
}
