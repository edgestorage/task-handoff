import { z } from "zod";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceSchema,
  LocalDockerImageSchema,
  NodeAgentDeleteResponseSchema,
  NodeAgentHealthSchema,
  NodeAgentExternalListenerSchema,
  NodeAgentInstanceProxyRawResponseSchema,
  NodeAgentPairingInviteResponseSchema,
  NodeAgentRemoteConnectResultSchema,
  NodeAgentRemoteControlPlaneSchema,
  NodeFolderTreeEntrySchema,
  NodeLocalFolderSchema,
  NodeModelAssignmentSchema,
  NodeModelPublicRecordSchema,
  NodeRuntimeSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
  safeParseStoredControlledInstance,
  type ControlledInstance,
  type Node,
  type NodeLocalFolder,
  type NodeModelPublicRecord,
  type NodeRuntime,
  type UpdateCheckRequest,
} from "@task-handoff/protocol/control-plane";
import { ControlPlaneNodeAgentClient, nodeAgentScopedError, type NodeAgentScopedError } from "./node-agent-client.ts";

export type NodeAgentFleetResult<T> = {
  items: T[];
  nodeErrors: NodeAgentScopedError[];
};

type NodeAgentListResult<T> = NodeAgentFleetResult<T>;

type NodeAgentInstanceParseResult = {
  instance?: ControlledInstance;
  error?: NodeAgentScopedError;
};

export class ControlPlaneNodeAgentGateway {
  private readonly client: ControlPlaneNodeAgentClient;

  constructor(client: ControlPlaneNodeAgentClient) {
    this.client = client;
  }

  request(node: Node, route: string, init: RequestInit = {}) {
    return this.client.request(node, route, init);
  }

  health(node: Node) {
    return this.client.requestSchema(node, "/health", NodeAgentHealthSchema);
  }

  checkUpdate(node: Node, input: UpdateCheckRequest) {
    return this.client.requestSchema(node, "/updates/check", UpdateCheckResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  applyUpdate(node: Node, input: UpdateCheckRequest) {
    return this.client.requestSchema(node, "/updates/apply", UpdateJobSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listUpdateJobs(node: Node) {
    return this.client.requestSchema(node, "/updates/jobs", z.array(UpdateJobSchema));
  }

  getExternalListener(node: Node) {
    return this.client.requestSchema(node, "/settings/external-listener", NodeAgentExternalListenerSchema);
  }

  updateExternalListener(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/settings/external-listener", NodeAgentExternalListenerSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  createPairingInvite(node: Node, input: unknown = {}) {
    return this.client.requestSchema(node, "/pairing/invites", NodeAgentPairingInviteResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input && typeof input === "object" ? input : {}),
    });
  }

  connectRemote(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/remotes/connect", NodeAgentRemoteConnectResultSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listRemotes(node: Node) {
    return this.client.requestSchema(node, "/remotes", z.array(NodeAgentRemoteControlPlaneSchema));
  }

  deleteRemote(node: Node, keyId: string) {
    return this.client.requestSchema(node, `/remotes/${encodeURIComponent(keyId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listDockerImages(node: Node) {
    return this.client.requestSchema(node, "/docker/images", z.array(LocalDockerImageSchema));
  }

  listFolderTree(node: Node, input: { path?: string; depth?: number } = {}) {
    const params = new URLSearchParams();
    if (input.path) {
      params.set("path", input.path);
    }
    if (input.depth !== undefined) {
      params.set("depth", String(input.depth));
    }
    const query = params.toString();
    return this.client.requestSchema(node, `/folders/tree${query ? `?${query}` : ""}`, z.array(NodeFolderTreeEntrySchema));
  }

  listLocalFolders(node: Node) {
    return this.client.requestSchema(node, "/local-folders", z.array(NodeLocalFolderSchema));
  }

  createLocalFolder(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/local-folders", NodeLocalFolderSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async requireLocalFolder(node: Node, folderId: string) {
    const folders = await this.listLocalFolders(node);
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) {
      const error = new Error(`Local folder ${folderId} was not found on node ${node.id}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_LOCAL_FOLDER_NOT_FOUND", nodeId: node.id, route: "/local-folders" });
      throw error;
    }
    return folder;
  }

  listRuntimes(node: Node) {
    return this.client.requestSchema(node, "/runtimes", z.array(NodeRuntimeSchema));
  }

  createRuntime(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/runtimes", NodeRuntimeSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateRuntime(node: Node, runtimeId: string, input: unknown) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}`;
    return this.client.requestSchema(node, route, NodeRuntimeSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  checkRuntime(node: Node, runtimeId: string) {
    const route = `/runtimes/${encodeURIComponent(runtimeId)}/check`;
    return this.client.requestSchema(node, route, NodeRuntimeSchema, { method: "POST" });
  }

  deleteRuntime(node: Node, runtimeId: string) {
    return this.client.requestSchema(node, `/runtimes/${encodeURIComponent(runtimeId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  deleteLocalFolder(node: Node, folderId: string) {
    return this.client.requestSchema(node, `/local-folders/${encodeURIComponent(folderId)}`, NodeAgentDeleteResponseSchema, {
      method: "DELETE",
    });
  }

  listModels(node: Node) {
    return this.client.requestSchema(node, "/models", z.array(NodeModelPublicRecordSchema));
  }

  createModel(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/models", NodeModelPublicRecordSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deployModel(node: Node, modelId: string, input: unknown) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}/deploy`, NodeModelPublicRecordSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateModel(node: Node, modelId: string, input: unknown) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeModelPublicRecordSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deleteModel(node: Node, modelId: string) {
    return this.client.requestSchema(node, `/models/${encodeURIComponent(modelId)}`, NodeAgentDeleteResponseSchema, { method: "DELETE" });
  }

  assignInstanceModels(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/model-assignment`, z.object({
      assignment: NodeModelAssignmentSchema,
      instance: ControlledInstanceSchema,
    }).strict(), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async listFleetModels(nodes: Node[]): Promise<NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }>> {
    const route = "/models";
    const results = await Promise.allSettled(nodes.map(async (node) => ({ node, models: await this.listModels(node) })));
    return results.reduce<NodeAgentFleetResult<{ nodeId: string; model: NodeModelPublicRecord }>>((current, result, index) => {
      if (result.status === "fulfilled") {
        current.items.push(...result.value.models.map((model) => ({ nodeId: result.value.node.id, model })));
      } else {
        const node = nodes[index];
        if (node) current.nodeErrors.push(nodeAgentScopedError(node, route, "GET", result.reason));
      }
      return current;
    }, { items: [], nodeErrors: [] });
  }

  async listFleetRuntimes(nodes: Node[]): Promise<NodeAgentFleetResult<NodeRuntime>> {
    const route = "/runtimes";
    const results = await Promise.allSettled(nodes.map(async (node) => ({
      node,
      runtimes: await this.listRuntimes(node),
    })));
    return results.reduce<NodeAgentFleetResult<NodeRuntime>>((current, result, index) => {
      if (result.status === "fulfilled") {
        current.items.push(...result.value.runtimes);
      } else {
        const node = nodes[index];
        if (node) {
          current.nodeErrors.push(nodeAgentScopedError(node, route, "GET", result.reason));
        }
      }
      return current;
    }, { items: [], nodeErrors: [] });
  }

  listInstances(node: Node) {
    return this.listInstancesWithDiagnostics(node).then((result) => result.items);
  }

  async listInstancesWithDiagnostics(node: Node): Promise<NodeAgentListResult<ControlledInstance>> {
    return this.client.requestSchema(node, "/instances", z.array(z.unknown()))
      .then((items) => items.reduce<NodeAgentListResult<ControlledInstance>>((current, item) => {
        const result = this.normalizeInstance(node, item);
        if (result.instance) {
          current.items.push(result.instance);
        }
        if (result.error) {
          current.nodeErrors.push(result.error);
        }
        return current;
      }, { items: [], nodeErrors: [] }));
  }

  createInstance(node: Node, input: unknown) {
    return this.client.requestSchema(node, "/instances", ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateInstance(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}`, ControlledInstanceSchema, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  deleteInstance(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/delete`, NodeAgentDeleteResponseSchema, {
      method: "POST",
    });
  }

  startInstance(node: Node, instanceId: string, input: unknown = {}) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/start`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  stopInstance(node: Node, instanceId: string) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/stop`, ControlledInstanceSchema, {
      method: "POST",
    });
  }

  restartInstance(node: Node, instanceId: string, input: unknown = {}) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/restart`, ControlledInstanceSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  proxyRawInstance(node: Node, instanceId: string, input: unknown) {
    return this.client.requestSchema(node, `/instances/${encodeURIComponent(instanceId)}/proxy/raw`, NodeAgentInstanceProxyRawResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async listFleetInstances(nodes: Node[]): Promise<NodeAgentFleetResult<ControlledInstance>> {
    const route = "/instances";
    const results = await Promise.allSettled(nodes.map(async (node) => ({
      node,
      result: await this.listInstancesWithDiagnostics(node),
    })));
    return results.reduce<NodeAgentFleetResult<ControlledInstance>>((current, result, index) => {
      if (result.status === "fulfilled") {
        current.items.push(...result.value.result.items);
        current.nodeErrors.push(...result.value.result.nodeErrors);
      } else {
        current.nodeErrors.push(nodeAgentScopedError(nodes[index], route, "GET", result.reason));
      }
      return current;
    }, { items: [], nodeErrors: [] });
  }

  private normalizeInstance(node: Node, value: unknown): NodeAgentInstanceParseResult {
    const route = "/instances";
    const method = "GET";
    const parsed = safeParseStoredControlledInstance(value);
    if (parsed.success) {
      if (parsed.data.protocolVersion && parsed.data.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
        this.client.logger?.warn?.({
          nodeId: node.id,
          instanceId: parsed.data.id,
          expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          actualProtocolVersion: parsed.data.protocolVersion,
          errorCode: "PROTOCOL_VERSION_MISMATCH",
        }, "node instance protocol version mismatch");
        return {
          instance: parsed.data,
          error: {
            nodeId: node.id,
            route,
            method,
            code: "PROTOCOL_VERSION_MISMATCH",
            message: `Node instance ${parsed.data.id} protocol version ${parsed.data.protocolVersion} does not match ${CONTROL_PLANE_PROTOCOL_VERSION}.`,
            statusCode: 502,
          },
        };
      }
      return { instance: parsed.data };
    }
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const instanceId = typeof record.id === "string" ? record.id : undefined;
    this.client.logger?.warn?.({
      nodeId: node.id,
      instanceId,
      errorCode: "NODE_INSTANCE_PAYLOAD_INVALID",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }, "node instance payload invalid");
    return {
      error: {
        nodeId: node.id,
        route,
        method,
        code: "NODE_INSTANCE_PAYLOAD_INVALID",
        message: instanceId ? `Node instance ${instanceId} payload is invalid.` : "Node instance payload is invalid.",
        statusCode: 502,
        issues: parsed.error.issues,
      },
    };
  }
}

export type { NodeLocalFolder, NodeRuntime };
