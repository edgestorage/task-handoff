import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { requireArgument } from "./support.ts";

const NODE_COLUMNS = [
  { key: "id", header: "node" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "health", header: "health" },
  { key: "connectionMode", header: "connection" },
  { key: "lastSeenAt", header: "last seen" },
  { key: "capabilities", header: "capabilities", width: 30 },
];

function renderRows(nodes: readonly Record<string, unknown>[]) {
  return nodes.map((node) => ({
    ...node,
    capabilities: Array.isArray(node.capabilities) ? (node.capabilities as string[]).join(",") : "",
    lastSeenAt: typeof node.lastSeenAt === "string" ? node.lastSeenAt : "",
  }));
}

export async function nodeList(context: CliContext) {
  const connection = await openConnection(context);
  const nodes = await connection.client.resources.nodes(context.signal);
  if (context.output.json) return { data: nodes };
  return { data: renderRows(nodes), columns: NODE_COLUMNS, message: nodes.length ? undefined : "No nodes matched." };
}

export async function nodeShow(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const connection = await openConnection(context);
  const nodes = await connection.client.resources.nodes(context.signal);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new ThctlError("CLI_NODE_NOT_FOUND", `No node \`${nodeId}\` is visible in the fleet directory.`, 7, { nodeId });
  }
  return { data: node, columns: NODE_COLUMNS };
}

export async function nodeRename(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const name = requireArgument(invocation, "name");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node rename",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}`, body: { name } }),
    () => connection.client.resources.updateNodeName(nodeId, name),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "node" },
      { key: "name", header: "name" },
    ],
    message: `Node \`${nodeId}\` renamed to \`${result.name}\`.`,
  };
}
