import { Buffer } from "node:buffer";
import {
  decodeNodeTunnelRequestBody,
  NodeTunnelRequestBodySchema,
} from "@task-handoff/protocol/control-plane";

/**
 * Relay JSON cannot carry binary bodies directly. New clients wrap them in the
 * same canonical body envelope used by node tunnels; legacy strings and plain
 * objects pass through unchanged for compatibility during rollout.
 */
export function decodeCloudRelayRequestBody(value: unknown): unknown {
  // Most relay requests carry ordinary JSON or text bodies. Avoid a Zod parse
  // on every one of them; only objects shaped like the tunnel envelope need it.
  if (!value || typeof value !== "object" || typeof (value as { encoding?: unknown }).encoding !== "string" || typeof (value as { data?: unknown }).data !== "string") return value;
  if (!NodeTunnelRequestBodySchema.safeParse(value).success) return value;
  const decoded = decodeNodeTunnelRequestBody(value);
  return decoded instanceof Uint8Array
    ? Buffer.from(decoded.buffer as ArrayBuffer, decoded.byteOffset, decoded.byteLength)
    : decoded;
}
