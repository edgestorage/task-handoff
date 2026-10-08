import { z } from "zod";
import {
  NodeAgentExternalListenerSchema,
  NodeAgentModelRelaySchema,
  NodeAgentControlPlaneConnectionCreateResultSchema,
  NodeAgentControlPlaneConnectionSchema,
  NodeAgentControlPlanePairingSchema,
  NodeAgentDeleteResponseSchema,
  NodeAgentPairingInviteResponseSchema,
  NodeFolderPlaceSchema,
  NodeFolderTreeEntrySchema,
  NodeImageAvailabilitySchema,
  NodeJoinInviteStatusSchema,
  NodeLocalFolderSchema,
  NodeRuntimeSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
} from "@task-handoff/protocol/control-plane";
import { NODE_CAPABILITIES, fetchNodeCapabilitySnapshot, requireNodeCapability } from "../capability.ts";
import { registerSecret } from "../redact.ts";
import { guardApprovalProtocol } from "../operation-approvals.ts";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readRequestBody, repeatableOption, requireArgument, requireOption } from "./support.ts";

const NODE_COLUMNS = [
  { key: "id", header: "node" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "health", header: "health" },
  { key: "connectionMode", header: "connection" },
];

const FOLDER_COLUMNS = [
  { key: "id", header: "folder" },
  { key: "name", header: "name", width: 24 },
  { key: "path", header: "path", width: 48 },
  { key: "updatedAt", header: "updated" },
];

const RUNTIME_COLUMNS = [
  { key: "id", header: "runtime" },
  { key: "name", header: "name", width: 24 },
  { key: "type", header: "type" },
  { key: "status", header: "status" },
  { key: "version", header: "version" },
];

const DOCKER_IMAGE_COLUMNS = [
  { key: "reference", header: "reference", width: 48 },
  { key: "id", header: "image id", width: 24 },
  { key: "sizeBytes", header: "size" },
  { key: "createdAt", header: "created" },
];

const UPDATE_JOB_COLUMNS = [
  { key: "id", header: "job" },
  { key: "status", header: "status" },
  { key: "fromVersion", header: "from" },
  { key: "toVersion", header: "to" },
  { key: "updatedAt", header: "updated" },
];

const PAIRING_COLUMNS = [
  { key: "keyId", header: "key id" },
  { key: "status", header: "status" },
  { key: "expiresAt", header: "expires" },
];

const CONNECTION_COLUMNS = [
  { key: "id", header: "connection" },
  { key: "controlPlaneName", header: "control plane", width: 24 },
  { key: "controlPlaneUrl", header: "url", width: 40 },
  { key: "status", header: "status" },
];

function rows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

function requireNodeId(invocation: CliInvocation) {
  return requireArgument(invocation, "nodeId");
}

/** 写命令前取一次能力快照，避免同一命令里重复读节点记录。 */
async function gatedNodeContext(context: CliContext, nodeId: string, commandId: string, required: { name: string; check: (capabilities: unknown) => boolean }[]) {
  const connection = await openConnection(context);
  if (required.length) {
    const snapshot = await fetchNodeCapabilitySnapshot(connection.client, nodeId, context.signal);
    for (const capability of required) requireNodeCapability(commandId, snapshot, capability);
  }
  return connection;
}

export async function nodeCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Node create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node create",
    () => ({ method: "POST", path: "/api/nodes", body }),
    () => connection.client.nodeAdmin.createNode(body),
  );
  if (!result) return;
  return { data: result, columns: NODE_COLUMNS, message: `Node \`${result.id}\` created.` };
}

export async function nodeRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const force = invocation.options.force === true;
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}${force ? "?force=true" : ""}` }),
    () => guardApprovalProtocol(connection, () => connection.client.approvals.removeNode(nodeId, force)),
  );
  if (!result) return;
  return { data: result, message: `Node \`${nodeId}\` removed (revoke: ${result.revoke.mode}${result.revoke.orphanRisk ? ", orphan risk" : ""}).` };
}

export async function nodeCheck(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const result = await connection.client.nodeAdmin.checkNode(nodeId);
  if (context.output.json) return { data: result };
  return { data: result, columns: [{ key: "id", header: "node" }, { key: "status", header: "status" }, { key: "checkedAt", header: "checked" }] };
}

export async function nodeSyncLocal(context: CliContext) {
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node sync-local",
    () => ({ method: "POST", path: "/api/nodes/local/sync" }),
    () => connection.client.nodeAdmin.syncLocalNode(),
  );
  if (!result) return;
  return { data: result, columns: NODE_COLUMNS, message: `Local node \`${result.id}\` synced.` };
}

export async function nodeFoldersList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const folders = await connection.client.nodeAdmin.listFolders(nodeId, context.signal);
  if (context.output.json) return { data: folders };
  return { data: rows(folders), columns: FOLDER_COLUMNS, message: folders.length ? undefined : "No folders matched." };
}

export async function nodeFoldersTree(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const path = optionString(invocation, "path");
  const depth = optionString(invocation, "depth");
  const connection = await openConnection(context);
  const tree = await connection.client.nodeAdmin.listFolderTree(nodeId, {
    ...(path ? { path } : {}),
    ...(depth ? { depth: Number(depth) } : {}),
  }, context.signal);
  if (context.output.json) return { data: tree };
  return { data: rows(tree), columns: [{ key: "path", header: "path", width: 60 }, { key: "name", header: "name", width: 24 }, { key: "type", header: "type" }] };
}

export async function nodeFoldersAdd(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "Folder create request");
  const connection = await gatedNodeContext(context, nodeId, "node folders add", [NODE_CAPABILITIES.localFolderPlaces]);
  const result = await performWrite(
    context,
    "node folders add",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/local-folders`, body }),
    () => connection.client.nodeAdmin.createFolder(nodeId, body),
  );
  if (!result) return;
  return { data: result, columns: FOLDER_COLUMNS, message: `Folder \`${result.id}\` added.` };
}

export async function nodeFoldersUpdate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const folderId = requireArgument(invocation, "folderId");
  const body = readRequestBody(invocation, "Folder update request");
  const connection = await gatedNodeContext(context, nodeId, "node folders update", [NODE_CAPABILITIES.localFolderPlaces, NODE_CAPABILITIES.localFolderNameUpdate]);
  const result = await performWrite(
    context,
    "node folders update",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}/local-folders/${encodeURIComponent(folderId)}`, body }),
    () => connection.client.nodeAdmin.updateFolder(nodeId, folderId, body),
  );
  if (!result) return;
  return { data: result, columns: FOLDER_COLUMNS, message: `Folder \`${folderId}\` updated.` };
}

export async function nodeFoldersRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const folderId = requireArgument(invocation, "folderId");
  const connection = await gatedNodeContext(context, nodeId, "node folders remove", [NODE_CAPABILITIES.localFolderPlaces]);
  const result = await performWrite(
    context,
    "node folders remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/local-folders/${encodeURIComponent(folderId)}` }),
    () => connection.client.nodeAdmin.removeFolder(nodeId, folderId),
  );
  if (!result) return;
  return { data: result, message: `Folder \`${folderId}\` removed.` };
}

export async function nodeRuntimesList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const runtimes = await connection.client.nodeAdmin.listRuntimes(nodeId, context.signal);
  if (context.output.json) return { data: runtimes };
  return { data: rows(runtimes), columns: RUNTIME_COLUMNS, message: runtimes.length ? undefined : "No runtimes matched." };
}

export async function nodeRuntimesCreate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "Runtime create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node runtimes create",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/runtimes`, body }),
    () => connection.client.nodeAdmin.createRuntime(nodeId, body),
  );
  if (!result) return;
  return { data: result, columns: RUNTIME_COLUMNS, message: `Runtime \`${result.id}\` created.` };
}

export async function nodeRuntimesUpdate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const runtimeId = requireArgument(invocation, "runtimeId");
  const body = readRequestBody(invocation, "Runtime update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node runtimes update",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}/runtimes/${encodeURIComponent(runtimeId)}`, body }),
    () => connection.client.nodeAdmin.updateRuntime(nodeId, runtimeId, body),
  );
  if (!result) return;
  return { data: result, columns: RUNTIME_COLUMNS, message: `Runtime \`${runtimeId}\` updated.` };
}

export async function nodeRuntimesRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const runtimeId = requireArgument(invocation, "runtimeId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node runtimes remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/runtimes/${encodeURIComponent(runtimeId)}` }),
    () => connection.client.nodeAdmin.removeRuntime(nodeId, runtimeId),
  );
  if (!result) return;
  return { data: result, message: `Runtime \`${runtimeId}\` removed.` };
}

export async function nodeRuntimesCheck(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const runtimeId = requireArgument(invocation, "runtimeId");
  const connection = await openConnection(context);
  const result = await connection.client.nodeAdmin.checkRuntime(nodeId, runtimeId);
  if (context.output.json) return { data: result };
  return { data: result, columns: RUNTIME_COLUMNS };
}

export async function nodeDockerImages(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const images = await connection.client.nodeAdmin.listDockerImages(nodeId, context.signal);
  if (context.output.json) return { data: images };
  return { data: rows(images), columns: DOCKER_IMAGE_COLUMNS, message: images.length ? undefined : "No docker images matched." };
}

export async function nodeImageOptions(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const options = await connection.client.nodeAdmin.imageOptions(nodeId, context.signal);
  if (context.output.json) return { data: options };
  return { data: rows(options), columns: [{ key: "id", header: "image" }, { key: "name", header: "name", width: 24 }, { key: "reference", header: "reference", width: 40 }] };
}

export async function nodeExternalListenerShow(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const listener = await connection.client.nodeAdmin.getExternalListener(nodeId, context.signal);
  if (context.output.json) return { data: listener };
  return { data: listener, columns: [{ key: "bindScope", header: "bind scope" }, { key: "port", header: "port" }, { key: "enabled", header: "enabled" }] };
}

export async function nodeExternalListenerSet(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "External listener update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node settings external-listener set",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}/settings/external-listener`, body }),
    () => guardApprovalProtocol(connection, () => connection.client.nodeAdmin.updateExternalListener(nodeId, body)),
  );
  if (!result) return;
  return { data: result, message: `External listener for \`${nodeId}\` updated.` };
}

export async function nodeModelRelayShow(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const relay = await connection.client.nodeAdmin.getModelRelay(nodeId, context.signal);
  if (context.output.json) return { data: relay };
  return { data: relay, columns: [{ key: "enabled", header: "enabled" }, { key: "source", header: "source" }, { key: "unknownModelPolicy", header: "unknownModelPolicy" }] };
}

export async function nodeModelRelaySet(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "Model relay update request");
  const connection = await gatedNodeContext(context, nodeId, "node settings model-relay set", [NODE_CAPABILITIES.modelRelay]);
  const result = await performWrite(
    context,
    "node settings model-relay set",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}/settings/model-relay`, body }),
    () => connection.client.nodeAdmin.updateModelRelay(nodeId, body),
  );
  if (!result) return;
  return { data: result, message: `Model relay for \`${nodeId}\` updated.` };
}

export async function nodeUpdatesJobs(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const jobs = await connection.client.nodeAdmin.updateJobs(nodeId, context.signal);
  if (context.output.json) return { data: jobs };
  return { data: rows(jobs), columns: UPDATE_JOB_COLUMNS, message: jobs.length ? undefined : "No update jobs matched." };
}

export async function nodeUpdatesCheck(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const config = optionString(invocation, "config");
  const body = config ? readRequestBody(invocation, "Update check request") : {};
  const connection = await openConnection(context);
  const result = await connection.client.nodeAdmin.checkUpdate(nodeId, body);
  if (context.output.json) return { data: result };
  return { data: result, columns: [{ key: "availableVersion", header: "available" }, { key: "channel", header: "channel" }, { key: "currentVersion", header: "current" }] };
}

const TERMINAL_UPDATE_STATUSES = new Set(["succeeded", "degraded", "failed"]);

export async function nodeUpdatesApply(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "Update apply request");
  const wait = invocation.options.wait === true;
  const connection = await openConnection(context);
  const job = await performWrite(
    context,
    "node updates apply",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/updates/apply`, body }),
    () => guardApprovalProtocol(connection, () => connection.client.nodeAdmin.applyUpdate(nodeId, body)),
  );
  if (!job) return;
  if (!wait) return { data: job, columns: UPDATE_JOB_COLUMNS, message: `Update job \`${job.id}\` queued (status ${job.status}).` };
  let current = job;
  for (;;) {
    if (TERMINAL_UPDATE_STATUSES.has(current.status)) {
      return { data: current, columns: UPDATE_JOB_COLUMNS, message: `Update job \`${current.id}\` finished with status ${current.status}.` };
    }
    await context.sleep(2000);
    if (context.signal.aborted) {
      throw new ThctlError("CLI_CANCELLED", "Stopped waiting for the update job; the job keeps running on the server.", 15, { jobId: current.id });
    }
    const jobs = await connection.client.nodeAdmin.updateJobs(nodeId, context.signal);
    current = jobs.find((candidate) => candidate.id === job.id) ?? current;
  }
}

export async function nodePairingInvite(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = optionString(invocation, "config") ? readRequestBody(invocation, "Pairing invite request") : {};
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node pairing invite",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/pairing/invites`, body }),
    () => connection.client.nodeAdmin.createPairingInvite(nodeId, body),
  );
  if (!result) return;
  registerSecret(result.joinToken);
  return { data: result, message: `Pairing invite for \`${nodeId}\` created (expires ${result.expiresAt}).` };
}

export async function nodePairingsList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const pairings = await connection.client.nodeAdmin.listControlPlanePairings(nodeId, context.signal);
  if (context.output.json) return { data: pairings };
  return { data: rows(pairings), columns: PAIRING_COLUMNS, message: pairings.length ? undefined : "No pairings matched." };
}

export async function nodePairingsRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const keyId = requireArgument(invocation, "keyId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node pairings remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/control-plane-pairings/${encodeURIComponent(keyId)}` }),
    () => connection.client.nodeAdmin.removeControlPlanePairing(nodeId, keyId),
  );
  if (!result) return;
  return { data: result, message: `Pairing \`${keyId}\` removed from \`${nodeId}\`.` };
}

export async function nodeConnectionsList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connection = await openConnection(context);
  const connections = await connection.client.nodeAdmin.listControlPlaneConnections(nodeId, context.signal);
  if (context.output.json) return { data: connections };
  return { data: rows(connections), columns: CONNECTION_COLUMNS, message: connections.length ? undefined : "No connections matched." };
}

export async function nodeConnectionsCreate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const body = readRequestBody(invocation, "Connection create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node connections create",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/control-plane-connections`, body }),
    () => connection.client.nodeAdmin.createControlPlaneConnection(nodeId, body),
  );
  if (!result) return;
  return { data: result, columns: CONNECTION_COLUMNS, message: `Connection created for \`${nodeId}\`.` };
}

export async function nodeConnectionsRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireNodeId(invocation);
  const connectionId = requireArgument(invocation, "connectionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node connections remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/control-plane-connections/${encodeURIComponent(connectionId)}` }),
    () => connection.client.nodeAdmin.removeControlPlaneConnection(nodeId, connectionId),
  );
  if (!result) return;
  return { data: result, message: `Connection \`${connectionId}\` removed from \`${nodeId}\`.` };
}

export const NODE_ADMIN_OUTPUT_SCHEMAS = {
  folders: z.array(NodeLocalFolderSchema),
  folderTree: z.array(NodeFolderTreeEntrySchema),
  folderPlaces: z.array(NodeFolderPlaceSchema),
  runtimes: z.array(NodeRuntimeSchema),
  dockerImages: z.array(
    z.looseObject({ reference: z.string().optional(), id: z.string().optional() }),
  ),
  imageOptions: z.array(NodeImageAvailabilitySchema),
  externalListener: NodeAgentExternalListenerSchema,
  modelRelay: NodeAgentModelRelaySchema,
  updateJobs: z.array(UpdateJobSchema),
  updateCheck: UpdateCheckResultSchema,
  updateApply: UpdateJobSchema,
  pairingInvite: NodeAgentPairingInviteResponseSchema,
  pairings: z.array(NodeAgentControlPlanePairingSchema),
  connections: z.array(NodeAgentControlPlaneConnectionSchema),
  connectionCreate: NodeAgentControlPlaneConnectionCreateResultSchema,
  nodeRemove: NodeAgentDeleteResponseSchema,
} as const;

export const NODE_JOIN_OUTPUT_SCHEMAS = {
  invite: z.looseObject({ id: z.string(), joinToken: z.string().optional(), expiresAt: z.string().optional() }),
  status: NodeJoinInviteStatusSchema,
  complete: z.looseObject({ node: z.looseObject({ id: z.string() }).optional() }),
} as const;

export { repeatableOption, requireOption };
