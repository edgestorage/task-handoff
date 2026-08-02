import {
  BuildInfoSchema,
  CONTROL_PLANE_PROTOCOL_VERSION,
  NodeSchema,
  type Node,
} from "@task-handoff/protocol/control-plane";
import { createId, type JsonCollection } from "../../shared/persistence/store.ts";
import { createDirectNodeAgentAuthHeaders } from "../../shared/security/node-agent-auth.ts";
import { parseNodeAgentIpcEndpoint } from "../../shared/transport/node-agent-ipc.ts";
import { CreateNodeInputSchema } from "../application/inputs.ts";
import { now } from "../application/helpers.ts";
import { publicNodeAgentCapabilities } from "../public-records.ts";
import { fetchDirectNodeAgentEndpoint } from "./direct-transport.ts";

type NodeAgentAuthContext = Pick<Node, "id" | "auth" | "connectionMode">;

type NodeConnectionManagerOptions = {
  nodes: JsonCollection<Node>;
  fetchImpl: typeof fetch;
  localNodeLabel: string;
  builtinNodeLabel: string;
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
};

export class NodeConnectionManager {
  private readonly options: NodeConnectionManagerOptions;

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
    if (pairing) {
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
    if (parsedInput.id && inspected?.nodeId && inspected.nodeId !== parsedInput.id) {
      throw connectionError(
        `Node agent id ${inspected.nodeId} does not match requested node id ${parsedInput.id}.`,
        "NODE_AGENT_ID_MISMATCH",
      );
    }
    const { joinToken: _joinToken, ...nodeInput } = parsedInput;
    return this.options.nodes.put(NodeSchema.parse({
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
    }));
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
      this.options.warn(
        { nodeEndpoint: endpoint, statusCode: response.status, errorCode: "NODE_AGENT_HEALTH_FAILED" },
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
      this.options.warn(
        { nodeEndpoint: endpoint, payload: payload.data, errorCode: "NODE_AGENT_ID_MISSING" },
        "node agent health response missing node id",
      );
      throw Object.assign(new Error("Node agent health response did not include nodeId."), {
        statusCode: 502,
        code: "NODE_AGENT_ID_MISSING",
      });
    }
    if (payload.data?.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
      this.options.warn({
        nodeId,
        nodeEndpoint: endpoint,
        expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        actualProtocolVersion: payload.data?.protocolVersion,
        build: payload.data?.build,
        errorCode: "PROTOCOL_VERSION_MISMATCH",
      }, "node agent protocol version mismatch");
    }
    const build = BuildInfoSchema.safeParse(payload.data?.build);
    this.options.info({
      nodeId,
      nodeEndpoint: endpoint,
      protocolVersion: payload.data.protocolVersion,
      build: build.success ? build.data : payload.data?.build,
    }, "node agent health check ok");
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
    if (typeof payload.data?.nodeId !== "string" || !payload.data.nodeId.trim()
      || typeof payload.data?.keyId !== "string" || !payload.data.keyId.trim()
      || typeof payload.data?.secret !== "string" || !payload.data.secret.trim()) {
      throw Object.assign(new Error("Node agent pairing response did not include nodeId, keyId, and secret."), {
        statusCode: 502,
        code: "NODE_AGENT_PAIRING_RESPONSE_INVALID",
      });
    }
    return {
      nodeId: payload.data.nodeId.trim(),
      keyId: payload.data.keyId.trim(),
      secret: payload.data.secret.trim(),
      pairedAt: typeof payload.data.pairedAt === "string" ? payload.data.pairedAt : now(),
    };
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
