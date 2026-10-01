import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { requireArgument } from "./support.ts";

const USER_COLUMNS = [
  { key: "id", header: "user" },
  { key: "displayName", header: "name", width: 24 },
  { key: "primaryUsername", header: "username" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

const SESSION_COLUMNS = [
  { key: "id", header: "session" },
  { key: "clientType", header: "client" },
  { key: "createdAt", header: "created" },
  { key: "expiresAt", header: "expires" },
  { key: "lastUsedAt", header: "last used" },
];

export async function userList(context: CliContext, invocation: CliInvocation) {
  const includeArchived = invocation.options["include-archived"] === true;
  const connection = await openConnection(context);
  const users = await connection.client.users.list({ includeArchived }, context.signal);
  if (context.output.json) return { data: users };
  return { data: users, columns: USER_COLUMNS, message: users.length ? undefined : "No users matched." };
}

export async function userShow(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const connection = await openConnection(context);
  const user = await connection.client.users.detail(userId, context.signal);
  if (context.output.json) return { data: user };
  return { data: user, columns: USER_COLUMNS };
}

export async function userSessions(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const connection = await openConnection(context);
  const sessions = await connection.client.users.sessions(userId, context.signal);
  if (context.output.json) return { data: sessions };
  return { data: sessions, columns: SESSION_COLUMNS, message: sessions.length ? undefined : "No sessions matched." };
}

export async function userSessionRevoke(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "user session-revoke",
    () => ({ method: "DELETE", path: `/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}` }),
    () => connection.client.users.revokeSession(userId, sessionId),
  );
  if (!result) return;
  if (!result.revoked) {
    throw new ThctlError("CLI_SESSION_NOT_REVOKED", `Session \`${sessionId}\` was not revoked.`, 8, { userId, sessionId });
  }
  return { data: result, message: `Session \`${sessionId}\` revoked.` };
}
