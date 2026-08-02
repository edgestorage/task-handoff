import {
  BuildInfoSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  NodeAgentPairingCompleteResultSchema,
  NodeAgentPairingSelfRevokeResultSchema,
  NodeSchema,
  type Node,
} from "@task-handoff/protocol/control-plane";
import { z } from "zod";
import { createId, type JsonCollection } from "../../shared/persistence/store.ts";
import { createDirectNodeAgentAuthHeaders } from "../../shared/security/node-agent-auth.ts";
import { parseNodeAgentIpcEndpoint } from "../../shared/transport/node-agent-ipc.ts";
import { CreateNodeInputSchema } from "../application/inputs.ts";
import { now } from "../application/helpers.ts";
import { publicNode, publicNodeAgentCapabilities } from "../public-records.ts";
import { fetchDirectNodeAgentEndpoint } from "./direct-transport.ts";

type NodeAgentAuthContext = Pick<Node, "id" | "auth" | "connectionMode">;
type CompletedPairing = {
  nodeId: string;
  keyId: string;
  secret: string;
  pairedAt: string;
  invalidResponse: boolean;
  unsafePublicIdentifiers: boolean;
};

export const PendingPairingRevokeSchema = z.object({
  id: z.string().min(1),
  endpoint: z.string().min(1),
  nodeId: z.string().min(1),
  keyId: z.string().min(1),
  secret: z.string().min(1),
  pairedAt: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type PendingPairingRevoke = z.infer<typeof PendingPairingRevokeSchema>;

type NodeConnectionManagerOptions = {
  nodes: JsonCollection<Node>;
  pendingPairingRevokes?: JsonCollection<PendingPairingRevoke>;
  fetchImpl: typeof fetch;
  localNodeLabel: string;
  builtinNodeLabel: string;
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
};

export class NodeConnectionManager {
  private readonly options: NodeConnectionManagerOptions;
  private readonly activePendingPairingRevokes = new Set<string>();

  constructor(options: NodeConnectionManagerOptions) {
    this.options = options;
  }

  async syncLocal() {
    const labels = {
      [this.options.localNodeLabel]: "true",
      [this.options.builtinNodeLabel]: "true",
    };
    const localStaticSecret = process.env.TASK_HANDOFF_NODE_AGENT_TOKEN?.trim() || undefined;
    const endpoint = defaultLocalNodeEndpoint();
    const connectionMode = localConnectionModeForEndpoint(endpoint);
    const probeNode = NodeSchema.parse({
      id: "node_local_probe",
      name: "Local Node Probe",
      connectionMode,
      auth: { mode: "local-static-key", secret: localStaticSecret },
      labels,
      createdAt: now(),
      updatedAt: now(),
    });
    const inspected = await this.inspect(endpoint, probeNode);
    const timestamp = now();
    const current = this.options.nodes.get(inspected.nodeId);
    for (const node of this.options.nodes.list()) {
      if (node.labels[this.options.localNodeLabel] === "true" && node.id !== inspected.nodeId) {
        this.options.nodes.delete(node.id);
      }
    }
    return this.options.nodes.put(NodeSchema.parse({
      ...(current || {}),
      id: inspected.nodeId,
      name: current?.name || "Local Node",
      connectionMode,
      auth: { mode: "local-static-key", secret: localStaticSecret },
      endpoint,
      controlEndpoint: endpoint,
      containerEndpoint: process.env.TASK_HANDOFF_NODE_AGENT_CONTAINER_URL,
      publicWebBase: process.env.TASK_HANDOFF_INSTANCE_PUBLIC_WEB_BASE,
      status: "online",
      health: "ok",
      capabilities: { ...(current?.capabilities || {}), agent: publicNodeAgentCapabilities(inspected.data) },
      labels: { ...(current?.labels || {}), ...labels },
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    }));
  }

  async create(input: unknown) {
    const parsedInput = CreateNodeInputSchema.parse(input);
    const timestamp = now();
    const connectionMode = parsedInput.connectionMode || "direct-http";
    const inputRecord = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    let auth = "auth" in inputRecord
      ? parsedInput.auth
      : { mode: connectionMode === "local-ipc" || connectionMode === "local-loopback" ? "local-static-key" as const : "paired-hmac" as const };
    const remote = connectionMode === "direct-http" || connectionMode === "reverse-wss";
    if (remote && auth.mode !== "paired-hmac") {
      throw connectionError("Remote node connections require paired-HMAC authentication.", "NODE_AGENT_REMOTE_REQUIRES_PAIRED_HMAC");
    }
    const controlEndpoint = parsedInput.controlEndpoint || parsedInput.endpoint;
    if (!controlEndpoint && connectionMode !== "reverse-wss") {
      throw connectionError("Node agent direct HTTP mode requires an endpoint.", "NODE_AGENT_ENDPOINT_REQUIRED");
    }
    const pairing = parsedInput.joinToken && controlEndpoint
      ? await this.completePairing(controlEndpoint, parsedInput.joinToken)
      : undefined;
    let pendingRevoke: PendingPairingRevoke | undefined;
    let nodePersistenceAttempted = false;
    try {
      pendingRevoke = pairing && controlEndpoint
        ? this.pendingPairingRevoke(controlEndpoint, pairing)
        : undefined;
      if (pendingRevoke) {
        this.activePendingPairingRevokes.add(pendingRevoke.id);
        this.options.pendingPairingRevokes?.put(pendingRevoke);
      }
      if (pairing) {
        if (pairing.invalidResponse || pairing.unsafePublicIdentifiers) {
          throw Object.assign(new Error("Node agent pairing response reflected secret material in a public identifier."), {
            statusCode: 502,
            code: "NODE_AGENT_PAIRING_RESPONSE_INVALID",
          });
        }
        auth = {
          mode: "paired-hmac",
          keyId: pairing.keyId,
          secret: pairing.secret,
          pairedAt: pairing.pairedAt,
          pairing: { status: "paired" },
        };
      }
      if (remote && !auth.secret) {
        throw connectionError("Remote node connections require a paired node secret or join token.", "NODE_AGENT_REMOTE_SECRET_REQUIRED");
      }
      if (remote && !auth.keyId) {
        throw connectionError("Remote node connections require a paired key id.", "NODE_AGENT_REMOTE_KEY_ID_REQUIRED");
      }
      const provisionalId = parsedInput.id || pairing?.nodeId || createId("node");
      const probeNode = NodeSchema.parse({
        id: provisionalId,
        name: parsedInput.name,
        connectionMode,
        auth,
        labels: parsedInput.labels || {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const inspected = connectionMode === "reverse-wss" && (parsedInput.id || pairing?.nodeId)
        ? undefined
        : await this.inspect(controlEndpoint || "", probeNode);
      const id = parsedInput.id || pairing?.nodeId || inspected?.nodeId || provisionalId;
      if (!id) throw connectionError("Node id is required.", "NODE_ID_REQUIRED");
      if (pairing && parsedInput.id && parsedInput.id !== pairing.nodeId) {
        throw connectionError(
          `Paired node id ${pairing.nodeId} does not match requested node id ${parsedInput.id}.`,
          "NODE_AGENT_ID_MISMATCH",
        );
      }
      if (parsedInput.id && inspected?.nodeId && inspected.nodeId !== parsedInput.id) {
        throw connectionError(
          `Node agent id ${inspected.nodeId} does not match requested node id ${parsedInput.id}.`,
          "NODE_AGENT_ID_MISMATCH",
        );
      }
      if (pairing && inspected?.nodeId && inspected.nodeId !== pairing.nodeId) {
        throw Object.assign(new Error("Node agent health identity did not match the completed pairing."), {
          statusCode: 502,
          code: "NODE_AGENT_PAIRING_IDENTITY_MISMATCH",
        });
      }
      const { joinToken: _joinToken, ...nodeInput } = parsedInput;
      const candidate = NodeSchema.parse({
        ...nodeInput,
        id,
        connectionMode,
        auth,
        endpoint: controlEndpoint,
        controlEndpoint,
        status: parsedInput.status || (inspected ? "online" : "unknown"),
        health: parsedInput.health || (inspected ? "ok" : "unknown"),
        capabilities: {
          ...(parsedInput.capabilities || {}),
          ...(inspected ? { agent: publicNodeAgentCapabilities(inspected.data) } : {}),
        },
        labels: parsedInput.labels || {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (pairing && nodePublicProjectionContainsSecret(candidate, pairing.secret)) {
        throw Object.assign(new Error("Node agent health response reflected pairing secret material."), {
          statusCode: 502,
          code: "NODE_AGENT_PAIRING_SECRET_REFLECTED",
        });
      }
      nodePersistenceAttempted = true;
      const stored = this.options.nodes.put(candidate);
      this.clearPendingPairingRevoke(pendingRevoke, pairing);
      return stored;
    } catch (error) {
      if (pairing && controlEndpoint) {
        const persistence = this.pairingPersistence(pairing);
        if (persistence.state === "present") {
          this.clearPendingPairingRevoke(pendingRevoke, pairing);
          return persistence.node;
        }
        if (persistence.state === "unknown" && nodePersistenceAttempted) {
          throw sanitizePostPairingError(Object.assign(
            new Error("Node creation persistence outcome is uncertain; pairing compensation is pending."),
            { statusCode: 503, code: "NODE_AGENT_PAIRING_PERSISTENCE_UNCERTAIN", retryable: true },
          ), pairing.secret);
        }
        await this.compensatePairing(controlEndpoint, pairing, error);
        this.clearPendingPairingRevoke(pendingRevoke, pairing);
        throw sanitizePostPairingError(error, pairing.secret);
      }
      throw error;
    } finally {
      if (pendingRevoke) this.activePendingPairingRevokes.delete(pendingRevoke.id);
    }
  }

  async recoverPendingPairingRevokes() {
    const pending = (this.options.pendingPairingRevokes?.list() || [])
      .filter((record) => !this.activePendingPairingRevokes.has(record.id));
    await Promise.all(pending.map(async (record) => {
      try {
        const pairing: CompletedPairing = {
          nodeId: record.nodeId,
          keyId: record.keyId,
          secret: record.secret,
          pairedAt: record.pairedAt,
          invalidResponse: false,
          unsafePublicIdentifiers: false,
        };
        const persistence = this.pairingPersistence(pairing);
        if (persistence.state === "present") {
          this.clearPendingPairingRevoke(record, pairing);
          return;
        }
        if (persistence.state === "unknown") {
          return;
        }
        await this.compensatePairing(record.endpoint, pairing, Object.assign(
          new Error("Recovering a pending pairing revocation."),
          { code: "NODE_AGENT_PAIRING_REVOCATION_PENDING" },
        ));
        this.clearPendingPairingRevoke(record, pairing);
      } catch {
        // Keep the private record for the next recovery pass.
      }
    }));
  }

  private pendingPairingRevoke(endpoint: string, pairing: CompletedPairing) {
    if (!this.options.pendingPairingRevokes) return undefined;
    const timestamp = now();
    return PendingPairingRevokeSchema.parse({
      id: createId("pairing_revoke"),
      endpoint,
      nodeId: pairing.nodeId,
      keyId: pairing.keyId,
      secret: pairing.secret,
      pairedAt: pairing.pairedAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private pairingPersistence(pairing: CompletedPairing):
    | { state: "present"; node: Node }
    | { state: "absent" }
    | { state: "unknown" } {
    let node: Node | undefined;
    try {
      node = this.options.nodes.get(pairing.nodeId);
    } catch {
      return { state: "unknown" };
    }
    return node?.auth.mode === "paired-hmac"
      && node.auth.keyId === pairing.keyId
      && node.auth.secret === pairing.secret
      ? { state: "present", node }
      : { state: "absent" };
  }

  private clearPendingPairingRevoke(record: PendingPairingRevoke | undefined, pairing: CompletedPairing | undefined) {
    if (!record) return;
    try {
      this.options.pendingPairingRevokes?.delete(record.id);
    } catch (error) {
      try {
        this.options.warn({
          nodeId: pairing ? safeDiagnosticIdentifier(pairing.nodeId, pairing.secret) : undefined,
          keyId: pairing ? safeDiagnosticIdentifier(pairing.keyId, pairing.secret) : undefined,
          errorCode: "NODE_AGENT_PAIRING_OUTBOX_CLEANUP_FAILED",
        }, "node agent pairing outbox cleanup failed; recovery will retry");
      } catch {
        // Outbox cleanup is best effort and must not change the committed result.
      }
    }
  }

  private async inspect(endpoint: string, node?: NodeAgentAuthContext) {
    const route = "/health";
    const headers = node
      ? createDirectNodeAgentAuthHeaders(node, { method: "GET", pathWithQuery: `/api/node-agent${route}` })
      : {};
    const response = await fetchDirectNodeAgentEndpoint(this.options.fetchImpl, endpoint, route, { headers });
    const payload = await response.json().catch(() => ({})) as {
      data?: { nodeId?: unknown; protocolVersion?: unknown; build?: unknown };
      error?: { message?: string };
    };
    if (!response.ok) {
      this.options.warn(redactDiagnosticSecrets(
        { nodeEndpoint: endpoint, statusCode: response.status, errorCode: "NODE_AGENT_HEALTH_FAILED" },
        node?.auth.secret,
      ),
        "node agent health check failed",
      );
      throw Object.assign(
        new Error(payload.error?.message || `Node agent health check failed with HTTP ${response.status}`),
        { statusCode: response.status, code: "NODE_AGENT_HEALTH_FAILED" },
      );
    }
    const nodeId = typeof payload.data?.nodeId === "string" && payload.data.nodeId.trim()
      ? payload.data.nodeId.trim()
      : undefined;
    if (!nodeId) {
      this.options.warn(redactDiagnosticSecrets(
        { nodeEndpoint: endpoint, errorCode: "NODE_AGENT_ID_MISSING" },
        node?.auth.secret,
      ),
        "node agent health response missing node id",
      );
      throw Object.assign(new Error("Node agent health response did not include nodeId."), {
        statusCode: 502,
        code: "NODE_AGENT_ID_MISSING",
      });
    }
    const build = BuildInfoSchema.safeParse(payload.data?.build);
    if (payload.data?.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
      this.options.warn(redactDiagnosticSecrets({
        nodeId,
        nodeEndpoint: endpoint,
        expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        actualProtocolVersion: payload.data?.protocolVersion,
        build: build.success ? build.data : undefined,
        errorCode: "PROTOCOL_VERSION_MISMATCH",
      }, node?.auth.secret), "node agent protocol version mismatch");
    }
    this.options.info(redactDiagnosticSecrets({
      nodeId,
      nodeEndpoint: endpoint,
      protocolVersion: payload.data.protocolVersion,
      build: build.success ? build.data : undefined,
    }, node?.auth.secret), "node agent health check ok");
    return { nodeId, data: payload.data || {} };
  }

  private async completePairing(endpoint: string, joinToken: string) {
    const response = await this.options.fetchImpl(`${endpoint.replace(/\/$/, "")}/api/node-agent/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinToken, controlPlaneName: "Control Plane" }),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: { nodeId?: unknown; keyId?: unknown; secret?: unknown; pairedAt?: unknown };
      error?: { message?: string };
    };
    if (!response.ok) {
      throw Object.assign(new Error(payload.error?.message || `Node agent pairing failed with status ${response.status}.`), {
        statusCode: response.status,
        code: "NODE_AGENT_PAIRING_FAILED",
      });
    }
    const raw = payload.data;
    if (typeof raw?.nodeId !== "string" || !raw.nodeId.trim()
      || typeof raw?.keyId !== "string" || !raw.keyId.trim()
      || typeof raw?.secret !== "string" || !raw.secret.trim()) {
      throw Object.assign(new Error("Node agent pairing response did not include nodeId, keyId, and secret."), {
        statusCode: 502,
        code: "NODE_AGENT_PAIRING_RESPONSE_INVALID",
      });
    }
    const parsed = NodeAgentPairingCompleteResultSchema.safeParse(raw);
    const nodeId = raw.nodeId.trim();
    const keyId = raw.keyId.trim();
    const secret = raw.secret.trim();
    const pairedAt = parsed.success ? parsed.data.pairedAt : now();
    return {
      nodeId,
      keyId,
      secret,
      pairedAt,
      invalidResponse: !parsed.success,
      unsafePublicIdentifiers: nodeId.includes(secret) || keyId.includes(secret),
    };
  }

  private async compensatePairing(endpoint: string, pairing: CompletedPairing, originalError: unknown) {
    const route = "/pairing/current";
    const pathWithQuery = `/api/node-agent${route}`;
    const node: NodeAgentAuthContext = {
      id: pairing.nodeId,
      connectionMode: "direct-http",
      auth: { mode: "paired-hmac", keyId: pairing.keyId, secret: pairing.secret },
    };
    try {
      const response = await fetchDirectNodeAgentEndpoint(this.options.fetchImpl, endpoint, route, {
        method: "DELETE",
        headers: createDirectNodeAgentAuthHeaders(node, { method: "DELETE", pathWithQuery }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: unknown } };
      if (!response.ok) {
        throw Object.assign(new Error(`Node agent pairing revoke failed with HTTP ${response.status}.`), {
          statusCode: response.status,
          code: safeErrorCode(payload.error?.code, pairing.secret, "NODE_AGENT_PAIRING_REVOKE_FAILED"),
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      const parsedReceipt = NodeAgentPairingSelfRevokeResultSchema.safeParse(payload.data);
      if (!parsedReceipt.success) {
        throw Object.assign(new Error("Node agent pairing revoke receipt was invalid."), {
          statusCode: 502,
          code: "NODE_AGENT_PAIRING_REVOKE_RECEIPT_INVALID",
          retryable: false,
        });
      }
      const receipt = parsedReceipt.data;
      if (receipt.keyId !== pairing.keyId) {
        throw Object.assign(new Error("Node agent pairing revoke receipt did not match the paired key."), {
          statusCode: 502,
          code: "NODE_AGENT_PAIRING_REVOKE_RECEIPT_MISMATCH",
          retryable: false,
        });
      }
      try {
        this.options.info({
          nodeId: safeDiagnosticIdentifier(pairing.nodeId, pairing.secret),
          keyId: safeDiagnosticIdentifier(pairing.keyId, pairing.secret),
          originalErrorCode: safeErrorCodeFromError(originalError, pairing.secret),
        }, "node agent pairing revoked after node creation failed");
      } catch {
        // Diagnostics must not turn a completed remote revocation into a failure.
      }
    } catch (compensationError) {
      const details = {
        nodeId: safeDiagnosticIdentifier(pairing.nodeId, pairing.secret),
        keyId: safeDiagnosticIdentifier(pairing.keyId, pairing.secret),
        originalErrorCode: safeErrorCodeFromError(originalError, pairing.secret),
        compensationErrorCode: safeErrorCodeFromError(compensationError, pairing.secret),
      };
      try {
        this.options.warn(details, "node agent pairing compensation failed");
      } catch {
        // Preserve the sanitized compensation error when diagnostics fail.
      }
      throw Object.assign(new Error("Node creation failed after pairing, and the remote pairing could not be revoked."), {
        statusCode: 502,
        code: "NODE_AGENT_PAIRING_COMPENSATION_FAILED",
        retryable: compensationRetryable(compensationError),
        details,
      });
    }
  }
}

function defaultLocalNodeEndpoint() {
  return process.env.TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT
    || process.env.TASK_HANDOFF_NODE_AGENT_ENDPOINT
    || "http://127.0.0.1:8091";
}

function localConnectionModeForEndpoint(endpoint: string): Node["connectionMode"] {
  return parseNodeAgentIpcEndpoint(endpoint) ? "local-ipc" : "local-loopback";
}

function connectionError(message: string, code: string) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function safeErrorCodeFromError(error: unknown, secret: string) {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return safeErrorCode(candidate, secret, "UNKNOWN_ERROR");
}

function safeErrorCode(value: unknown, secret: string, fallback: string) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value) || value.includes(secret)) return fallback;
  return value;
}

function compensationRetryable(error: unknown) {
  return error && typeof error === "object" && "retryable" in error && typeof error.retryable === "boolean"
    ? error.retryable
    : true;
}

function safeDiagnosticIdentifier(value: string, secret: string) {
  return value.includes(secret) ? "[redacted]" : value;
}

function redactDiagnosticSecrets(value: Record<string, unknown>, secret?: string): Record<string, unknown> {
  if (!secret) return value;
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === "string") return candidate.includes(secret) ? "[redacted]" : candidate;
    if (Array.isArray(candidate)) return candidate.map(redact);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).map(([key, nested]) => [
        key.includes(secret) ? "[redacted-key]" : key,
        redact(nested),
      ]));
    }
    return candidate;
  };
  return redact(value) as Record<string, unknown>;
}

function nodePublicProjectionContainsSecret(node: Node, secret: string) {
  return containsSecret(publicNode(node), secret);
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((candidate) => containsSecret(candidate, secret));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => key.includes(secret) || containsSecret(nested, secret));
  }
  return false;
}

function sanitizePostPairingError(error: unknown, secret: string) {
  const message = error instanceof Error && !error.message.includes(secret)
    ? error.message
    : "Node creation failed after pairing.";
  const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 502;
  const sanitized = Object.assign(new Error(message), {
    statusCode,
    code: safeErrorCodeFromError(error, secret),
  });
  if (error && typeof error === "object" && "retryable" in error && typeof error.retryable === "boolean") {
    Object.assign(sanitized, { retryable: error.retryable });
  }
  return sanitized;
}
