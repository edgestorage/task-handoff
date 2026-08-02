import {
  NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS,
  hmacHeadersFromRecord,
  sha256Hex,
  signNodeAgentRequest,
  timingSafeHexEqual,
} from "../../shared/security/node-agent-auth.ts";
import type { NodeAgentIdentityService } from "./service.ts";

function requestBodyForHmac(body: unknown) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

export class NodeAgentPairedHmacVerifier {
  private readonly usedNonces = new Map<string, number>();
  private readonly identity: NodeAgentIdentityService;
  private readonly nodeId: string;
  private readonly overrideSecret?: string;
  private readonly overrideKeyId?: string;
  private readonly nowMs: () => number;

  constructor(
    identity: NodeAgentIdentityService,
    nodeId: string,
    overrideSecret?: string,
    overrideKeyId?: string,
    nowMs: () => number = Date.now,
  ) {
    this.identity = identity;
    this.nodeId = nodeId;
    this.overrideSecret = overrideSecret;
    this.overrideKeyId = overrideKeyId;
    this.nowMs = nowMs;
  }

  hasRemoteSecrets() {
    return this.identity.remoteSecrets(this.overrideSecret, this.overrideKeyId).length > 0;
  }

  verify(request: { method: string; url: string; headers: Record<string, unknown>; body: unknown }) {
    const headers = hmacHeadersFromRecord(request.headers);
    if (!headers.nodeId && !headers.signature) return false;
    const selfRevoke = request.method === "DELETE" && request.url.split("?")[0] === "/api/node-agent/pairing/current";
    const remoteSecrets = this.identity.remoteSecrets(this.overrideSecret, this.overrideKeyId, selfRevoke);
    if (!remoteSecrets.length) return false;
    if (headers.nodeId !== this.nodeId) {
      throw Object.assign(new Error("Invalid node agent HMAC node id."), { statusCode: 401, code: "NODE_AGENT_HMAC_NODE_MISMATCH" });
    }
    if (!headers.keyId) {
      throw Object.assign(new Error("Node agent HMAC key id is missing."), { statusCode: 401, code: "NODE_AGENT_HMAC_KEY_MISSING" });
    }
    const candidateSecrets = remoteSecrets.filter((item) => headers.keyId === item.keyId);
    if (!candidateSecrets.length) {
      throw Object.assign(new Error("Invalid node agent HMAC key id."), { statusCode: 401, code: "NODE_AGENT_HMAC_KEY_INVALID" });
    }
    const timestampMs = Date.parse(headers.timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(this.nowMs() - timestampMs) > NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS) {
      throw Object.assign(new Error("Node agent HMAC timestamp is outside the allowed window."), { statusCode: 401, code: "NODE_AGENT_HMAC_TIMESTAMP_INVALID" });
    }
    if (!headers.nonce) {
      throw Object.assign(new Error("Node agent HMAC nonce is missing."), { statusCode: 401, code: "NODE_AGENT_HMAC_NONCE_MISSING" });
    }
    this.pruneNonces();
    const nonceKey = `${headers.nodeId}:${headers.keyId}:${headers.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      throw Object.assign(new Error("Node agent HMAC nonce was already used."), { statusCode: 401, code: "NODE_AGENT_HMAC_NONCE_REPLAY" });
    }
    const bodySha256 = sha256Hex(requestBodyForHmac(request.body));
    if (headers.bodySha256 !== bodySha256) {
      throw Object.assign(new Error("Node agent HMAC body hash mismatch."), { statusCode: 401, code: "NODE_AGENT_HMAC_BODY_HASH_INVALID" });
    }
    const signatureMatches = candidateSecrets.some((item) => timingSafeHexEqual(headers.signature, signNodeAgentRequest(item.secret, {
      keyId: headers.keyId,
      method: request.method,
      pathWithQuery: request.url,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      bodySha256,
    })));
    if (!signatureMatches) {
      throw Object.assign(new Error("Invalid node agent HMAC signature."), { statusCode: 401, code: "NODE_AGENT_HMAC_SIGNATURE_INVALID" });
    }
    // Retain the nonce until the signed timestamp itself can no longer pass the
    // timestamp-window check. Future-skewed timestamps can remain valid for
    // almost two windows after their first acceptance.
    this.usedNonces.set(nonceKey, timestampMs + NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS + 1);
    return headers.keyId;
  }

  private pruneNonces() {
    const cutoff = this.nowMs();
    for (const [key, expiresAt] of this.usedNonces) {
      if (expiresAt <= cutoff) this.usedNonces.delete(key);
    }
  }
}
