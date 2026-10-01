import { randomUUID } from "node:crypto";
import { ThctlError, usageError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import type { ControlPlaneClient } from "@task-handoff/control-plane-client";
import { optionString, requireArgument } from "./support.ts";

const STORY_COLUMNS = [
  { key: "id", header: "story" },
  { key: "title", header: "title", width: 30 },
  { key: "ownerNodeId", header: "node" },
  { key: "documents", header: "docs" },
  { key: "archivedAt", header: "archived" },
  { key: "updatedAt", header: "updated" },
];

const RUN_COLUMNS = [
  { key: "id", header: "run" },
  { key: "eventType", header: "event" },
  { key: "status", header: "status" },
  { key: "scheduledFor", header: "scheduled" },
  { key: "aiSessionId", header: "session" },
  { key: "startedAt", header: "started" },
];

function storyResult(context: CliContext, story: unknown) {
  if (context.output.json) return { data: story };
  return { data: storyRows([story as Record<string, unknown>])[0], columns: STORY_COLUMNS };
}

function storyRows(stories: readonly Record<string, unknown>[]) {
  return stories.map((story) => ({
    ...story,
    documents: Array.isArray(story.documents) ? `${(story.documents as unknown[]).length}` : "0",
    archivedAt: typeof story.archivedAt === "string" ? story.archivedAt : "",
  }));
}

/**
 * 节点是 story 路由的必填维度；没有显式 --node 时用同一份权威列表定位 ownerNodeId，
 * 不做本地缓存，也不根据 ID 形状推断。
 */
async function resolveStoryNodeId(connection: { client: ControlPlaneClient }, storyId: string, explicitNodeId?: string) {
  if (explicitNodeId) return explicitNodeId;
  const listing = await connection.client.stories.list();
  const story = listing.stories.find((candidate) => candidate.id === storyId);
  if (!story) {
    throw new ThctlError(
      "CLI_STORY_NOT_FOUND",
      `No story \`${storyId}\` is visible in the authoritative directory${listing.unavailableNodeIds.length ? ` (unavailable nodes: ${listing.unavailableNodeIds.join(", ")})` : ""}.`,
      7,
      { storyId, unavailableNodeIds: listing.unavailableNodeIds },
    );
  }
  return story.ownerNodeId;
}

async function resolveCreateNodeId(connection: { client: ControlPlaneClient }, explicitNodeId?: string) {
  if (explicitNodeId) return explicitNodeId;
  const nodes = await connection.client.resources.nodes();
  if (nodes.length === 1) return nodes[0].id;
  throw usageError(
    "CLI_NODE_REQUIRED",
    nodes.length === 0
      ? "No node is registered; register a node before creating stories."
      : `More than one node is registered (${nodes.map((node) => node.id).join(", ")}); pass --node <nodeId>.`,
    { nodeIds: nodes.map((node) => node.id) },
  );
}

export async function storyList(context: CliContext) {
  const connection = await openConnection(context);
  const listing = await connection.client.stories.list(undefined, context.signal);
  if (context.output.json) return { data: listing };
  const message = listing.unavailableNodeIds.length
    ? `Unavailable nodes: ${listing.unavailableNodeIds.join(", ")}`
    : listing.stories.length ? undefined : "No stories matched.";
  return { data: storyRows(listing.stories), columns: STORY_COLUMNS, message };
}

export async function storyShow(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const story = await connection.client.stories.get(storyId, nodeId);
  return storyResult(context, story);
}

export async function storyCreate(context: CliContext, invocation: CliInvocation) {
  const title = requireArgument(invocation, "title");
  const description = optionString(invocation, "description");
  const maxIdle = optionString(invocation, "max-idle-ai-sessions");
  const input = {
    title,
    ...(description ? { description } : {}),
    ...(maxIdle ? { maxIdleAiSessions: parsePositiveInteger(maxIdle, "max-idle-ai-sessions") } : {}),
  };
  const connection = await openConnection(context);
  const nodeId = await resolveCreateNodeId(connection, optionString(invocation, "node"));
  const result = await performWrite(
    context,
    "story create",
    () => ({ method: "POST", path: "/api/stories", body: { nodeId, input } }),
    () => connection.client.stories.create(nodeId, input),
  );
  if (!result) return;
  return { ...storyResult(context, result), message: `Story \`${result.id}\` created on node \`${nodeId}\`.` };
}

export async function storyUpdate(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const title = optionString(invocation, "title");
  const description = optionString(invocation, "description");
  const maxIdle = optionString(invocation, "max-idle-ai-sessions");
  const input = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(maxIdle ? { maxIdleAiSessions: parsePositiveInteger(maxIdle, "max-idle-ai-sessions") } : {}),
  };
  if (Object.keys(input).length === 0) throw usageError("CLI_OPTION_MISSING", "Provide at least one of --title, --description or --max-idle-ai-sessions.", { command: "story update" });
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const result = await performWrite(
    context,
    "story update",
    () => ({ method: "PATCH", path: `/api/stories/${encodeURIComponent(storyId)}`, body: { nodeId, input } }),
    () => connection.client.stories.update(storyId, nodeId, input),
  );
  if (!result) return;
  return { ...storyResult(context, result), message: `Story \`${storyId}\` updated.` };
}

function storyLifecycle(action: "archive" | "restore" | "remove") {
  return async (context: CliContext, invocation: CliInvocation) => {
    const storyId = requireArgument(invocation, "storyId");
    const connection = await openConnection(context);
    const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
    if (action === "remove") {
      const removed = await performWrite(
        context,
        "story remove",
        () => ({ method: "DELETE", path: `/api/stories/${encodeURIComponent(storyId)}?nodeId=${encodeURIComponent(nodeId)}` }),
        () => connection.client.stories.remove(storyId, nodeId),
      );
      if (!removed) return;
      if (!removed.deleted) throw new ThctlError("CLI_STORY_NOT_REMOVED", `Story \`${storyId}\` was not removed.`, 8, { storyId });
      return { data: removed, message: `Story \`${storyId}\` removed.` };
    }
    const result = await performWrite(
      context,
      `story ${action}`,
      () => ({ method: "POST", path: `/api/stories/${encodeURIComponent(storyId)}/${action}`, body: { nodeId } }),
      () => action === "archive"
        ? connection.client.stories.archive(storyId, nodeId)
        : connection.client.stories.restore(storyId, nodeId),
    );
    if (!result) return;
    return { ...storyResult(context, result), message: `Story \`${storyId}\` ${action === "archive" ? "archived" : "restored"}.` };
  };
}

export const storyArchive = storyLifecycle("archive");
export const storyRestore = storyLifecycle("restore");
export const storyRemove = storyLifecycle("remove");

export async function storyDocumentUpdate(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const storyPath = requireArgument(invocation, "path");
  const title = optionString(invocation, "title");
  const nextPath = optionString(invocation, "new-path");
  const input = { ...(title ? { title } : {}), ...(nextPath ? { storyPath: nextPath } : {}) };
  if (Object.keys(input).length === 0) throw usageError("CLI_OPTION_MISSING", "Provide --title or --new-path.", { command: "story document update" });
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const result = await performWrite(
    context,
    "story document update",
    () => ({ method: "PATCH", path: `/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, body: { nodeId, input } }),
    () => connection.client.stories.updateDocument(storyId, nodeId, storyPath, input),
  );
  if (!result) return;
  return { ...storyResult(context, result), message: `Document \`${storyPath}\` updated on story \`${storyId}\`.` };
}

export async function storyDocumentRemove(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const storyPath = requireArgument(invocation, "path");
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const result = await performWrite(
    context,
    "story document remove",
    () => ({ method: "DELETE", path: `/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, body: { nodeId } }),
    () => connection.client.stories.removeDocument(storyId, nodeId, storyPath),
  );
  if (!result) return;
  return { data: result, message: `Document \`${storyPath}\` removed from story \`${storyId}\`.` };
}

export async function storyDocumentReorder(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const paths = (invocation.rawArgs ?? []).slice(1).map((entry) => entry.trim()).filter(Boolean);
  if (paths.length === 0) throw usageError("CLI_ARGUMENT_MISSING", "Missing required argument <path...>.", { argument: "path" });
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const input = { storyPaths: paths };
  const result = await performWrite(
    context,
    "story document reorder",
    () => ({ method: "POST", path: `/api/stories/${encodeURIComponent(storyId)}/documents/order`, body: { nodeId, input } }),
    () => connection.client.stories.reorderDocuments(storyId, nodeId, input),
  );
  if (!result) return;
  return { ...storyResult(context, result), message: `Documents reordered on story \`${storyId}\`.` };
}

export async function storyAutomationList(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const listing = await connection.client.stories.listAutomations(storyId, nodeId);
  if (context.output.json) return { data: listing };
  return {
    data: listing.automations,
    columns: [
      { key: "automation.id", header: "automation" },
      { key: "automation.enabled", header: "enabled" },
      { key: "effectiveStatus", header: "status" },
      { key: "automation.actionId", header: "action" },
      { key: "nextRunAt", header: "next run" },
    ],
    message: listing.automations.length ? undefined : "No automations matched.",
  };
}

export async function storyAutomationShow(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const automationId = requireArgument(invocation, "automationId");
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const automation = await connection.client.stories.getAutomation(storyId, automationId, nodeId);
  if (context.output.json) return { data: automation };
  return { data: automation, columns: [
    { key: "automation.id", header: "automation" },
    { key: "automation.enabled", header: "enabled" },
    { key: "effectiveStatus", header: "status" },
    { key: "lastRun.status", header: "last run" },
    { key: "nextRunAt", header: "next run" },
  ] };
}

function automationEnabled(enabled: boolean) {
  return async (context: CliContext, invocation: CliInvocation) => {
    const storyId = requireArgument(invocation, "storyId");
    const automationId = requireArgument(invocation, "automationId");
    const connection = await openConnection(context);
    const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
    const result = await performWrite(
      context,
      enabled ? "story automation enable" : "story automation disable",
      () => ({ method: "POST", path: `/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/${enabled ? "enable" : "disable"}`, body: { nodeId } }),
      () => connection.client.stories.setAutomationEnabled(storyId, automationId, nodeId, enabled),
    );
    if (!result) return;
    return { data: result, message: `Automation \`${automationId}\` ${enabled ? "enabled" : "disabled"}.` };
  };
}

export const storyAutomationEnable = automationEnabled(true);
export const storyAutomationDisable = automationEnabled(false);

export async function storyAutomationRun(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const automationId = requireArgument(invocation, "automationId");
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const input = { clientRequestId };
  const result = await performWrite(
    context,
    "story automation run",
    () => ({ method: "POST", path: `/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/run`, body: { nodeId, input } }),
    () => connection.client.stories.runAutomation(storyId, automationId, nodeId, input),
  );
  if (!result) return;
  return { data: result, columns: RUN_COLUMNS, message: `Automation \`${automationId}\` run ${result.status}.` };
}

export async function storyAutomationRuns(context: CliContext, invocation: CliInvocation) {
  const storyId = requireArgument(invocation, "storyId");
  const automationId = requireArgument(invocation, "automationId");
  const connection = await openConnection(context);
  const nodeId = await resolveStoryNodeId(connection, storyId, optionString(invocation, "node"));
  const listing = await connection.client.stories.automationRuns(storyId, automationId, nodeId);
  if (context.output.json) return { data: listing };
  return { data: listing.runs, columns: RUN_COLUMNS, message: listing.runs.length ? undefined : "No runs matched." };
}

function parsePositiveInteger(value: string, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw usageError("CLI_INVALID_OPTION", `--${option} must be a non-negative integer.`, { option, value });
  return parsed;
}
