import {
  NodeRelayAllocationResponseSchema,
  NodeRelayBindingRedemptionRequestSchema,
  NodeRelayBindingRedemptionSchema,
  NodeRelayCredentialRenewalRequestSchema,
  NodeRelayCredentialSchema,
  type NodeRelayNodeAllocation,
} from "@task-handoff/cloud-contracts";
import { nodeRelayFingerprint } from "../../shared/cloud-relay/node-relay-session.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export type CloudRelayRedemption = {
  nodeHandle: string;
  accountId: string;
  serviceOrigin: string;
  credential: string;
  credentialExpiresAt: string;
  serviceSigningKey?: { kid: string; publicKey: string };
};

function normalizedOrigin(value: string) {
  return new URL(value).origin;
}

/**
 * The node-facing Coordinator API: redemption, credential renewal, allocation
 * polling and unbind. Every request is a plain outbound HTTPS call; nothing
 * here ever exposes a node endpoint, an instance or a local path.
 */
export class NodeRelayCloudClient {
  private readonly cloudOrigin: string | (() => string);
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onOriginSuccess?: (origin: string) => void;
  private readonly onOriginFailure?: (origin: string) => void;

  constructor(options: {
    cloudOrigin: string | (() => string);
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    onOriginSuccess?: (origin: string) => void;
    onOriginFailure?: (origin: string) => void;
  }) {
    this.cloudOrigin = options.cloudOrigin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onOriginSuccess = options.onOriginSuccess;
    this.onOriginFailure = options.onOriginFailure;
  }

  get origin() {
    return normalizedOrigin(typeof this.cloudOrigin === "function" ? this.cloudOrigin() : this.cloudOrigin);
  }

  async redeem(input: { bindingToken: string; nodeId: string; publicKey: string; displayName?: string }): Promise<CloudRelayRedemption> {
    const body = NodeRelayBindingRedemptionRequestSchema.parse({
      token: input.bindingToken,
      nodeId: input.nodeId,
      nodePublicKey: input.publicKey,
      nodePublicKeyFingerprint: nodeRelayFingerprint(input.publicKey),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    const data = await this.post("/api/v1/node-relay/v1/redeem", body);
    return NodeRelayBindingRedemptionSchema.parse(data);
  }

  async renew(credential: string) {
    const body = NodeRelayCredentialRenewalRequestSchema.parse({ credential });
    const data = await this.post("/api/v1/node-relay/v1/credential/renew", body, { credential });
    return NodeRelayCredentialSchema.parse(data);
  }

  async allocations(credential: string, input: { nodeId: string; controlPlaneId?: string; refreshControlPlaneIds?: string[] }): Promise<NodeRelayNodeAllocation[]> {
    const data = await this.post("/api/v1/node-relay/v1/allocations", {
      nodeId: input.nodeId,
      ...(input.controlPlaneId ? { controlPlaneId: input.controlPlaneId } : {}),
      ...(input.refreshControlPlaneIds?.length ? { refreshControlPlaneIds: input.refreshControlPlaneIds } : {}),
    }, { credential });
    return NodeRelayAllocationResponseSchema.parse(data).allocations;
  }

  async unbind(credential: string) {
    const body = NodeRelayCredentialRenewalRequestSchema.parse({ credential });
    const data = await this.post("/api/v1/node-relay/v1/unbind", body, { credential });
    return Boolean((data as { unbound?: unknown })?.unbound);
  }

  private async post(path: string, body: unknown, options: { credential?: string } = {}) {
    const origin = this.origin;
    const response = await this.fetchImpl(new URL(path, origin).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      this.onOriginFailure?.(origin);
      throw cloudRelayClientError("NODE_AGENT_CLOUD_RELAY_UNREACHABLE", error instanceof Error ? error.message : String(error));
    });
    const payload = await response.json().catch(() => ({} as Record<string, unknown>)) as { data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (!response.ok) {
      if (response.status >= 500) this.onOriginFailure?.(origin);
      const code = typeof payload.error?.code === "string" ? payload.error.code : `NODE_AGENT_CLOUD_RELAY_HTTP_${response.status}`;
      const message = typeof payload.error?.message === "string" ? payload.error.message : `Cloud relay request failed with HTTP ${response.status}.`;
      throw Object.assign(cloudRelayClientError(code, message), { statusCode: response.status });
    }
    this.onOriginSuccess?.(origin);
    return payload.data;
  }
}

export function cloudRelayClientError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
