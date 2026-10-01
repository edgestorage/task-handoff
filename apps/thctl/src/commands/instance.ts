import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";

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
