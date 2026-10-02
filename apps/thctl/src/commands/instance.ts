import { InstanceCreateInputSchema, InstanceDeleteInputSchema } from "@task-handoff/protocol/control-plane";
import { CLI_EXIT_CODES, ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readJsonFile, requireOption } from "./support.ts";

function requireInstanceId(invocation: CliInvocation) {
  const instanceId = invocation.args.instanceId?.trim();
  if (!instanceId) throw new ThctlError("CLI_ARGUMENT_MISSING", "Missing required argument <instanceId>.", 2);
  return instanceId;
}

const INSTANCE_COLUMNS = [
  { key: "id", header: "instance" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "health", header: "health" },
  { key: "connectionStatus", header: "connection" },
  { key: "nodeId", header: "node" },
  { key: "runtime.type", header: "runtime" },
  { key: "workspace.status", header: "workspace" },
  { key: "aiSessions.runningCount", header: "running" },
];

export async function instanceList(context: CliContext, invocation: CliInvocation) {
  const connection = await openConnection(context);
  const entries = await connection.client.resources.instanceBoard(context.signal);
  const nodeId = typeof invocation.options.node === "string" ? invocation.options.node.trim() : "";
  const filtered = nodeId ? entries.filter((entry) => entry.nodeId === nodeId) : entries;
  return { data: filtered, columns: INSTANCE_COLUMNS, message: filtered.length ? undefined : "No controlled instances matched." };
}

export async function instanceShow(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const connection = await openConnection(context);
  const entries = await connection.client.resources.instanceBoard(context.signal);
  const entry = entries.find((candidate) => candidate.id === instanceId);
  if (!entry) {
    throw new ThctlError("CLI_INSTANCE_NOT_FOUND", `No controlled instance \`${instanceId}\` is visible to this account.`, 7, { instanceId });
  }
  return { data: entry, columns: INSTANCE_COLUMNS };
}

function lifecycleHandler(action: "start" | "stop" | "restart") {
  return async (context: CliContext, invocation: CliInvocation) => {
    const instanceId = requireInstanceId(invocation);
    const connection = await openConnection(context);
    const result = await performWrite(
      context,
      `instance ${action} ${instanceId}`,
      () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/${action}`, body: {} }),
      () => connection.client.resources.instanceAction(instanceId, action),
    );
    if (!result) return;
    return {
      data: result,
      columns: [{ key: "id", header: "instance" }, { key: "status", header: "status" }],
      message: `Instance \`${instanceId}\` is ${result.status}.`,
    };
  };
}

export const instanceStart = lifecycleHandler("start");
export const instanceStop = lifecycleHandler("stop");
export const instanceRestart = lifecycleHandler("restart");

const INSTANCE_CREATE_COLUMNS = [
  { key: "id", header: "instance" },
  { key: "name", header: "name", width: 24 },
  { key: "nodeId", header: "node" },
  { key: "status", header: "status" },
  { key: "startOutcome.status", header: "start" },
];

const INSTANCE_DELETE_COLUMNS = [
  { key: "instanceId", header: "instance" },
  { key: "containerDeleted", header: "container" },
  { key: "completed", header: "completed" },
];

/** create 的复杂入参来自 --config 文件（POST /api/controlled-instances 的 wire body），
 *  --name/--node/--start 只覆盖同名 wire 字段，不新增协议字段。 */
export async function instanceCreate(context: CliContext, invocation: CliInvocation) {
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, InstanceCreateInputSchema, "instance config");
  const name = optionString(invocation, "name");
  const nodeId = optionString(invocation, "node");
  const body = {
    ...input,
    ...(name ? { name } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(invocation.options.start === true ? { start: true } : {}),
  };
  const connection = await openConnection(context);
  const created = await performWrite(
    context,
    "instance create",
    () => ({ method: "POST", path: "/api/controlled-instances", body }),
    () => connection.client.resources.createInstance(body),
  );
  if (!created) return;
  const message = created.startOutcome.status === "failed"
    ? `Instance \`${created.id}\` created but start failed: ${created.startOutcome.error?.message ?? "unknown error"}.`
    : created.startOutcome.status === "started"
      ? `Instance \`${created.id}\` created; start requested (status: ${created.status}).`
      : `Instance \`${created.id}\` created (status: ${created.status}).`;
  return { data: created, columns: INSTANCE_CREATE_COLUMNS, message };
}

export async function instanceDelete(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const input = InstanceDeleteInputSchema.parse({ deleteVolumes: invocation.options.volumes === true });
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    `instance delete ${instanceId}`,
    () => ({ method: "DELETE", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}`, body: input }),
    () => connection.client.resources.deleteInstance(instanceId, input),
  );
  if (!result) return;
  if (!result.completed) {
    throw new ThctlError(
      "CLI_INSTANCE_DELETE_INCOMPLETE",
      `Instance \`${instanceId}\` deletion is incomplete; re-run the same command after resolving the failed volumes.`,
      CLI_EXIT_CODES.conflict,
      { instanceId, volumeResults: result.volumeResults },
    );
  }
  return {
    data: result,
    columns: INSTANCE_DELETE_COLUMNS,
    message: result.retainedVolumes.length
      ? `Instance \`${instanceId}\` deleted; ${result.retainedVolumes.length} volume(s) retained (pass --volumes to delete them).`
      : `Instance \`${instanceId}\` deleted.`,
  };
}

export async function instanceRename(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const name = invocation.args.name?.trim();
  if (!name) throw new ThctlError("CLI_ARGUMENT_MISSING", "Missing required argument <name>.", 2);
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    `instance rename ${instanceId}`,
    () => ({ method: "PATCH", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}`, body: { name } }),
    () => connection.client.resources.updateInstanceName(instanceId, name),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "instance" },
      { key: "name", header: "name", width: 24 },
    ],
    message: `Instance \`${instanceId}\` renamed to \`${result.name}\`.`,
  };
}
