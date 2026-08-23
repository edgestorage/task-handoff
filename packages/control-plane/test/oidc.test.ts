import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyOidcIdToken } from "../src/control-plane/auth/oidc.ts";

function signedToken(input: { issuer?: string; audience?: string; nonce?: string; exp?: number } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: input.issuer || "https://id.example.com",
    sub: "subject-1",
    aud: input.audience || "control-plane",
    nonce: input.nonce || "nonce-1",
    exp: input.exp || Math.floor(Date.now() / 1000) + 300,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url");
  return { token: `${signingInput}.${signature}`, jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256" }] } };
}

test("OIDC ID token verifies signature, issuer, audience, nonce and expiry", () => {
  const valid = signedToken();
  assert.equal(verifyOidcIdToken({ token: valid.token, jwks: valid.jwks, issuer: "https://id.example.com", clientId: "control-plane", nonce: "nonce-1" }).sub, "subject-1");
  assert.throws(() => verifyOidcIdToken({ token: valid.token, jwks: valid.jwks, issuer: "https://other.example.com", clientId: "control-plane", nonce: "nonce-1" }));
  assert.throws(() => verifyOidcIdToken({ token: valid.token, jwks: valid.jwks, issuer: "https://id.example.com", clientId: "wrong", nonce: "nonce-1" }));
  assert.throws(() => verifyOidcIdToken({ token: valid.token, jwks: valid.jwks, issuer: "https://id.example.com", clientId: "control-plane", nonce: "wrong" }));
  const expired = signedToken({ exp: Math.floor(Date.now() / 1000) - 1 });
  assert.throws(() => verifyOidcIdToken({ token: expired.token, jwks: expired.jwks, issuer: "https://id.example.com", clientId: "control-plane", nonce: "nonce-1" }));
});
