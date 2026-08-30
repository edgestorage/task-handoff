import crypto from "node:crypto";
import { z } from "zod";

export const OidcDiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
}).passthrough();

const OidcTokenClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().trim().min(1).max(500),
  aud: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]),
  exp: z.number().int().positive(),
  iat: z.number().int().positive().optional(),
  nonce: z.string().trim().min(1),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  preferred_username: z.string().trim().min(1).max(160).optional(),
}).passthrough();

function decodeJson(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

export function verifyOidcIdToken(input: {
  token: string;
  jwks: unknown;
  issuer: string;
  clientId: string;
  nonce: string;
  now?: number;
}) {
  const [encodedHeader, encodedPayload, encodedSignature] = input.token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("OIDC ID token is malformed.");
  const header = z.object({ alg: z.enum(["RS256", "ES256"]), kid: z.string().trim().min(1) }).passthrough().parse(decodeJson(encodedHeader));
  const keys = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(input.jwks).keys;
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error("OIDC ID token signing key was not found.");
  const publicKey = crypto.createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: publicKey, ...(header.alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}) },
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!verified) throw new Error("OIDC ID token signature is invalid.");
  const claims = OidcTokenClaimsSchema.parse(decodeJson(encodedPayload));
  const issuer = input.issuer.replace(/\/$/, "");
  if (claims.iss.replace(/\/$/, "") !== issuer) throw new Error("OIDC ID token issuer is invalid.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(input.clientId)) throw new Error("OIDC ID token audience is invalid.");
  if (claims.nonce !== input.nonce) throw new Error("OIDC ID token nonce is invalid.");
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (claims.exp <= nowSeconds) throw new Error("OIDC ID token is expired.");
  return claims;
}
