import crypto from "node:crypto";

export const NODE_AGENT_HMAC_VERSION = "TASK_HANDOFF_NODE_AGENT_V1";
export const NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS = 60_000;
export const NODE_TUNNEL_API_PATH = "/api/node-tunnel";

export type NodeAgentHmacInput = {
  keyId: string;
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
};

export type NodeAgentHmacHeaders = {
  "x-taskhandoff-node-id": string;
  "x-taskhandoff-key-id": string;
  "x-taskhandoff-timestamp": string;
  "x-taskhandoff-nonce": string;
  "x-taskhandoff-body-sha256": string;
  "x-taskhandoff-signature": string;
};

export function sha256Hex(value: string | Buffer = "") {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalNodeAgentString(input: NodeAgentHmacInput) {
  return [
    NODE_AGENT_HMAC_VERSION,
    input.keyId,
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export function signNodeAgentRequest(secret: string, input: NodeAgentHmacInput) {
  return crypto.createHmac("sha256", secret).update(canonicalNodeAgentString(input)).digest("hex");
}

export function createNodeAgentHmacHeaders(input: {
  nodeId: string;
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body?: string | Buffer;
  timestamp?: string;
  nonce?: string;
}): NodeAgentHmacHeaders {
  const timestamp = input.timestamp || new Date().toISOString();
  const nonce = input.nonce || crypto.randomBytes(18).toString("base64url");
  const bodySha256 = sha256Hex(input.body || "");
  const signature = signNodeAgentRequest(input.secret, {
    keyId: input.keyId,
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    timestamp,
    nonce,
    bodySha256,
  });
  return {
    "x-taskhandoff-node-id": input.nodeId,
    "x-taskhandoff-key-id": input.keyId,
    "x-taskhandoff-timestamp": timestamp,
    "x-taskhandoff-nonce": nonce,
    "x-taskhandoff-body-sha256": bodySha256,
    "x-taskhandoff-signature": signature,
  };
}

export function hmacHeadersFromRecord(headers: Record<string, unknown>) {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const text = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : value === undefined ? "" : String(value);
    normalized.set(key.toLowerCase(), text);
  }
  return {
    nodeId: normalized.get("x-taskhandoff-node-id") || "",
    keyId: normalized.get("x-taskhandoff-key-id") || "",
    timestamp: normalized.get("x-taskhandoff-timestamp") || "",
    nonce: normalized.get("x-taskhandoff-nonce") || "",
    bodySha256: normalized.get("x-taskhandoff-body-sha256") || "",
    signature: normalized.get("x-taskhandoff-signature") || "",
  };
}

export function timingSafeHexEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
