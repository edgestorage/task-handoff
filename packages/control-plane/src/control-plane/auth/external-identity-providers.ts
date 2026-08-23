import { z } from "zod";

export type ExternalIdentityClaims = {
  subject: string;
  verifiedEmail?: string;
  displayName?: string;
};

export type ExternalIdentityProviderAdapter = {
  kind: "oidc" | "github";
  identityKind: "oidc" | "oauth";
  normalizeClaims(input: unknown): ExternalIdentityClaims;
};

const OidcClaimsSchema = z.object({
  sub: z.string().trim().min(1).max(500),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  preferred_username: z.string().trim().min(1).max(160).optional(),
}).passthrough();

const GitHubUserSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().trim().regex(/^\d+$/)]),
  login: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160).nullable().optional(),
  email: z.string().email().nullable().optional(),
}).passthrough();

const adapters: Record<ExternalIdentityProviderAdapter["kind"], ExternalIdentityProviderAdapter> = {
  oidc: {
    kind: "oidc",
    identityKind: "oidc",
    normalizeClaims(input) {
      const claims = OidcClaimsSchema.parse(input);
      return {
        subject: claims.sub,
        ...(claims.email && claims.email_verified === true ? { verifiedEmail: claims.email } : {}),
        ...((claims.name || claims.preferred_username) ? { displayName: claims.name || claims.preferred_username } : {}),
      };
    },
  },
  github: {
    kind: "github",
    identityKind: "oauth",
    normalizeClaims(input) {
      const user = GitHubUserSchema.parse(input);
      return {
        subject: String(user.id),
        ...(user.email ? { verifiedEmail: user.email } : {}),
        displayName: user.name || user.login,
      };
    },
  },
};

export function externalIdentityProviderAdapter(kind: string) {
  const adapter = adapters[kind as keyof typeof adapters];
  if (!adapter) throw Object.assign(new Error(`Unsupported external identity provider adapter: ${kind}`), {
    code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNSUPPORTED",
    statusCode: 400,
  });
  return adapter;
}

export function externalIdentityProviderAdapters() {
  return Object.values(adapters);
}
