import {
  ControlPlaneProxyErrorSchema,
  ProxyBindingSchema,
  ProxyInviteSchema,
  PublicProxyBindingSchema,
  PublicProxyInviteSchema,
  type ProxyBinding,
  type ProxyInvite,
  type PublicProxyBinding,
  type PublicProxyInvite,
} from "@task-handoff/protocol/control-plane-proxy";
import { z } from "zod";

export const ControlPlaneProxyAuthoritySchema = z.object({
  revision: z.number().int().nonnegative(),
  invites: z.array(ProxyInviteSchema),
  bindings: z.array(ProxyBindingSchema),
}).strict();

export type ControlPlaneProxyAuthority = z.infer<typeof ControlPlaneProxyAuthoritySchema>;

const recordKeys = {
  invite: new Set(Object.keys(ProxyInviteSchema.shape)),
  binding: new Set(Object.keys(ProxyBindingSchema.shape)),
};

function pick(input: unknown, keys: Iterable<string>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries([...keys].filter((key) => key in source).map((key) => [key, source[key]]));
}

export function sanitizeStoredProxyRecord(
  kind: keyof typeof recordKeys,
  input: unknown,
  onWarning?: (warning: { kind: string; fields: string[] }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const keys = recordKeys[kind];
  const unknown = Object.keys(source).filter((key) => !keys.has(key));
  if (unknown.length > 0) onWarning?.({ kind, fields: unknown });
  const value = pick(source, keys) as Record<string, unknown>;
  if (kind === "binding" && value.lastError) {
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
    invites: Array.isArray(source.invites)
      ? source.invites.map((value) => sanitizeStoredProxyRecord("invite", value, onWarning))
      : source.invites,
    bindings: Array.isArray(source.bindings)
      ? source.bindings.map((value) => sanitizeStoredProxyRecord("binding", value, onWarning))
      : source.bindings,
  };
}

export function publicProxyInvite(invite: ProxyInvite): PublicProxyInvite {
  const { tokenHash: _tokenHash, ...value } = invite;
  return PublicProxyInviteSchema.parse(value);
}

export function publicProxyBinding(binding: ProxyBinding): PublicProxyBinding {
  const { credentialHash: _credentialHash, ...value } = binding;
  return PublicProxyBindingSchema.parse(value);
}

export {
  ProxyBindingSchema as ProxyBindingRecordSchema,
  ProxyInviteSchema as ProxyInviteRecordSchema,
};

export type ProxyBindingRecord = ProxyBinding;
export type ProxyInviteRecord = ProxyInvite;
