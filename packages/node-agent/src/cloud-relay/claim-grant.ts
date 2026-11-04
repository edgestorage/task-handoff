import crypto from "node:crypto";
import { NodeRelayClaimGrantSchema, canonicalJson, type NodeRelayClaimGrant } from "@task-handoff/cloud-contracts";

/**
 * Verifies the cloud-signed claim grant with the key the node pinned at
 * redemption. The signature format is the platform capability envelope
 * (`issuerId.protectedHeader.signature`), the protected header binds the
 * purpose, key id and issuer, and the body is canonical JSON of the grant
 * minus the signature. Any mismatch is fatal: a node never trusts an unsigned
 * or unpinned grant, so the Relay cannot fabricate an authorization.
 */
export function verifyNodeRelayClaimGrant(input: {
  grant: unknown;
  trust: { kid: string; publicKey: string };
  now?: number;
}): NodeRelayClaimGrant {
  const parsed = NodeRelayClaimGrantSchema.safeParse(input.grant);
  if (!parsed.success) throw claimGrantError("NODE_RELAY_CLAIM_GRANT_INVALID");
  const grant = parsed.data;
  const parts = grant.signature.split(".");
  if (parts.length !== 3) throw claimGrantError("NODE_RELAY_CLAIM_GRANT_INVALID");
  const [issuerId, protectedHeader, signature] = parts;
  if (!issuerId || !protectedHeader || !signature) throw claimGrantError("NODE_RELAY_CLAIM_GRANT_INVALID");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(protectedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw claimGrantError("NODE_RELAY_CLAIM_GRANT_INVALID");
  }
  if (header.alg !== "EdDSA" || header.purpose !== "node-relay-claim-grant" || header.kid !== input.trust.kid || header.issuer !== issuerId) {
    throw claimGrantError("NODE_RELAY_CLAIM_GRANT_UNTRUSTED");
  }
  const { signature: _signature, ...payload } = grant;
  const body = Buffer.from(canonicalJson(payload)).toString("base64url");
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(`${protectedHeader}.${body}`),
      crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: input.trust.publicKey }, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw claimGrantError("NODE_RELAY_CLAIM_GRANT_SIGNATURE_INVALID");
  const now = input.now ?? Date.now();
  if (Date.parse(grant.expiresAt) <= now) throw claimGrantError("NODE_RELAY_CLAIM_GRANT_EXPIRED");
  return grant;
}

export function claimGrantError(code: string) {
  return Object.assign(new Error("The cloud claim grant could not be verified."), { code, retryable: true });
}
