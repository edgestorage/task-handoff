import { CliProfileSchema, normalizeControlPlaneOrigin, profileLabelFromOrigin, type CliProfile } from "../config.ts";
import { fetchControlPlaneIdentity } from "../control-plane.ts";
import { ThctlError } from "../errors.ts";
import { performWrite, type CliContext, type CliInvocation } from "../runtime.ts";

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new ThctlError("CLI_ARGUMENT_MISSING", `Missing required argument <${name}>.`, 2);
  return value.trim();
}

export async function profileAdd(context: CliContext, invocation: CliInvocation) {
  const origin = normalizeControlPlaneOrigin(requireString(invocation.args.origin, "origin"));
  const identity = await fetchControlPlaneIdentity(origin, context.fetchImpl);
  const existingByOrigin = context.store.findByOrigin(origin);
  if (existingByOrigin && (existingByOrigin.controlPlaneId !== identity.payload.controlPlaneId
    || existingByOrigin.fingerprint !== identity.payload.publicKey.fingerprint)) {
    throw new ThctlError(
      "CLI_IDENTITY_CHANGED",
      `Profile \`${existingByOrigin.label}\` is pinned to a different identity. Run \`thctl profile trust ${existingByOrigin.label}\` after verifying the new fingerprint ${identity.payload.publicKey.fingerprint}.`,
      13,
      { profile: existingByOrigin.label },
    );
  }
  const existingByIdentity = existingByOrigin
    ?? context.store.findByControlPlane(identity.payload.controlPlaneId, identity.payload.publicKey.fingerprint);
  const label = (invocation.options.label as string | undefined)?.trim()
    || existingByIdentity?.label
    || profileLabelFromOrigin(origin);
  const now = new Date().toISOString();
  const profile: CliProfile = CliProfileSchema.parse({
    label,
    origin,
    controlPlaneId: identity.payload.controlPlaneId,
    fingerprint: identity.payload.publicKey.fingerprint,
    protocolVersion: identity.payload.protocolVersion,
    capabilities: identity.payload.capabilities,
    createdAt: existingByIdentity?.createdAt ?? now,
    updatedAt: now,
    trustedAt: now,
    lastUsedAt: now,
    ...(existingByIdentity?.loginMode ? { loginMode: existingByIdentity.loginMode } : {}),
  });
  context.store.save(profile);
  if (!context.store.defaultProfile()) context.store.setDefault(label);
  return {
    data: profile,
    columns: [{ key: "label", header: "profile" }, { key: "origin", header: "origin" }, { key: "fingerprint", header: "fingerprint" }],
    message: existingByIdentity
      ? `Reused existing profile \`${profile.label}\` for ${origin}.`
      : `Added profile \`${profile.label}\` for ${origin}.`,
  };
}

export async function profileList(context: CliContext) {
  const profiles = context.store.list();
  const defaultProfile = context.store.defaultProfile();
  return {
    data: profiles.map((profile) => ({ ...profile, default: profile.label === defaultProfile })),
    columns: [
      { key: "label", header: "profile" },
      { key: "origin", header: "origin" },
      { key: "controlPlaneId", header: "controlPlaneId" },
      { key: "protocolVersion", header: "protocol" },
      { key: "fingerprint", header: "fingerprint", width: 28 },
      { key: "default", header: "default" },
    ],
  };
}

export async function profileUse(context: CliContext, invocation: CliInvocation) {
  const label = requireString(invocation.args.label, "label");
  context.store.setDefault(label);
  return { data: { defaultProfile: label }, message: `Default profile is now \`${label}\`.` };
}

export async function profileShow(context: CliContext, invocation: CliInvocation) {
  const label = invocation.args.label?.trim();
  const profile = label ? context.store.get(label) : context.store.select(context.profile, context.env);
  if (!profile) throw new ThctlError("CLI_PROFILE_UNKNOWN", `Unknown profile \`${label}\`.`, 7, { profile: label });
  const credential = context.store.secrets().read(profile.label);
  return {
    data: {
      ...profile,
      signedIn: Boolean(credential),
      ...(credential?.expiresAt ? { sessionExpiresAt: credential.expiresAt } : {}),
    },
  };
}

export async function profileRemove(context: CliContext, invocation: CliInvocation) {
  const label = requireString(invocation.args.label, "label");
  const profile = context.store.get(label);
  if (!profile) throw new ThctlError("CLI_PROFILE_UNKNOWN", `Unknown profile \`${label}\`.`, 7, { profile: label });
  return performWrite(
    context,
    `profile remove ${label}`,
    () => ({ method: "DELETE", path: `local:profiles/${label}` }),
    async () => {
      const removed = context.store.remove(label);
      return { data: { label, removed }, message: removed ? `Removed profile \`${label}\`.` : undefined };
    },
  );
}

export async function profileTrust(context: CliContext, invocation: CliInvocation) {
  const label = requireString(invocation.args.label, "label");
  const profile = context.store.get(label);
  if (!profile) throw new ThctlError("CLI_PROFILE_UNKNOWN", `Unknown profile \`${label}\`.`, 7, { profile: label });
  const identity = await fetchControlPlaneIdentity(profile.origin, context.fetchImpl);
  const fingerprint = identity.payload.publicKey.fingerprint;
  const current = profile.fingerprint;
  context.output.warn(`Pinned fingerprint: ${current}\nPresented fingerprint: ${fingerprint}`);
  if (current === fingerprint) {
    return { data: { label, fingerprint, trusted: true, changed: false }, message: `Profile \`${label}\` already trusts this Control Plane identity.` };
  }
  if (identity.payload.controlPlaneId !== profile.controlPlaneId) {
    throw new ThctlError(
      "CLI_IDENTITY_MISMATCH",
      `Profile \`${label}\` is pinned to Control Plane ${profile.controlPlaneId}, but ${profile.origin} now presents ${identity.payload.controlPlaneId}. Refusing to re-trust a different Control Plane; add it as a new profile instead.`,
      13,
    );
  }
  return performWrite(
    context,
    `profile trust ${label}`,
    () => ({ method: "PATCH", path: `local:profiles/${label}`, body: { fingerprint } }),
    async () => {
      const now = new Date().toISOString();
      const trusted = context.store.save({
        ...profile,
        fingerprint,
        protocolVersion: identity.payload.protocolVersion,
        capabilities: identity.payload.capabilities,
        trustedAt: now,
        updatedAt: now,
        identityChangedAt: now,
        replacedFingerprint: current,
      });
      return { data: trusted, message: `Profile \`${label}\` now trusts ${fingerprint}.` };
    },
  );
}
