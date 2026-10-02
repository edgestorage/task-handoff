import { registerSecret } from "../redact.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readRequestBody, requireArgument } from "./support.ts";

export async function nodeJoinInvite(context: CliContext, invocation: CliInvocation) {
  const body = optionString(invocation, "config") ? readRequestBody(invocation, "Join invite request") : {};
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node-join invite",
    () => ({ method: "POST", path: "/api/node-join/invites", body }),
    () => connection.client.nodeAdmin.createJoinInvite(body),
  );
  if (!result) return;
  registerSecret(result.joinToken);
  return {
    data: result,
    columns: [
      { key: "id", header: "invite" },
      { key: "expiresAt", header: "expires" },
    ],
    message: `Join invite \`${result.id}\` created.`,
  };
}

export async function nodeJoinStatus(context: CliContext, invocation: CliInvocation) {
  const inviteId = requireArgument(invocation, "inviteId");
  const connection = await openConnection(context);
  const status = await connection.client.nodeAdmin.joinInviteStatus(inviteId, context.signal);
  if (context.output.json) return { data: status };
  return { data: status, columns: [{ key: "id", header: "invite" }, { key: "status", header: "status" }, { key: "nodeId", header: "node" }] };
}

export async function nodeJoinComplete(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Join completion request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "node-join complete",
    () => ({ method: "POST", path: "/api/node-join/complete", body }),
    () => connection.client.nodeAdmin.completeJoin(body),
  );
  if (!result) return;
  return {
    data: result,
    columns: [{ key: "id", header: "node" }, { key: "name", header: "name", width: 24 }, { key: "status", header: "status" }],
    message: `Node \`${result.id}\` joined the Control Plane.`,
  };
}
