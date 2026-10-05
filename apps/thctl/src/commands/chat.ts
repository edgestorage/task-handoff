import { registerSecret } from "../redact.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { readRequestBody, readTokenFromStdin, requireArgument } from "./support.ts";

const BRIDGE_COLUMNS = [
  { key: "id", header: "bridge" },
  { key: "channel", header: "channel" },
  { key: "name", header: "name", width: 24 },
  { key: "running", header: "running" },
  { key: "tokenSet", header: "token" },
];

const SESSION_COLUMNS = [
  { key: "id", header: "session" },
  { key: "channel", header: "channel" },
  { key: "bridgeId", header: "bridge" },
  { key: "chatId", header: "chat" },
  { key: "updatedAt", header: "updated" },
];

const MOBILE_SESSION_COLUMNS = [
  { key: "id", header: "session" },
  { key: "userAgent", header: "client", width: 30 },
  { key: "createdAt", header: "created" },
  { key: "expiresAt", header: "expires" },
];

function rows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

async function bridgeBody(invocation: CliInvocation, label: string) {
  const body = readRequestBody(invocation, label);
  if (invocation.options["token-stdin"] === true) {
    const token = await readTokenFromStdin(invocation);
    body.token = token;
    registerSecret(token);
  }
  return body;
}

export async function chatStatus(context: CliContext) {
  const connection = await openConnection(context);
  const status = await connection.client.chatGateway.status(context.signal);
  if (context.output.json) return { data: status };
  return { data: rows(status.bridges), columns: BRIDGE_COLUMNS, message: `Chat gateway ${status.running ? "running" : "stopped"}.` };
}

export async function chatBridgesList(context: CliContext) {
  const connection = await openConnection(context);
  const bridges = await connection.client.chatGateway.listBridges(context.signal);
  if (context.output.json) return { data: bridges };
  return { data: rows(bridges), columns: BRIDGE_COLUMNS, message: bridges.length ? undefined : "No chat bridges matched." };
}

export async function chatBridgesCreate(context: CliContext, invocation: CliInvocation) {
  const body = await bridgeBody(invocation, "Chat bridge create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "chat bridges create",
    () => ({ method: "POST", path: "/api/chat-gateway/bridges", body }),
    () => connection.client.chatGateway.createBridge(body),
  );
  if (!result) return;
  return { data: result, columns: BRIDGE_COLUMNS, message: `Chat bridge \`${result.id}\` created.` };
}

export async function chatBridgesUpdate(context: CliContext, invocation: CliInvocation) {
  const bridgeId = requireArgument(invocation, "bridgeId");
  const body = await bridgeBody(invocation, "Chat bridge update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "chat bridges update",
    () => ({ method: "PATCH", path: `/api/chat-gateway/bridges/${encodeURIComponent(bridgeId)}`, body }),
    () => connection.client.chatGateway.updateBridge(bridgeId, body),
  );
  if (!result) return;
  return { data: result, columns: BRIDGE_COLUMNS, message: `Chat bridge \`${bridgeId}\` updated.` };
}

export async function chatBridgesStart(context: CliContext, invocation: CliInvocation) {
  const bridgeId = requireArgument(invocation, "bridgeId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "chat bridges start",
    () => ({ method: "POST", path: `/api/chat-gateway/bridges/${encodeURIComponent(bridgeId)}/start` }),
    () => connection.client.chatGateway.startBridge(bridgeId),
  );
  if (!result) return;
  return { data: result, message: `Chat bridge \`${bridgeId}\` started (${result.running ? "running" : "not running"}).` };
}

export async function chatBridgesStop(context: CliContext, invocation: CliInvocation) {
  const bridgeId = requireArgument(invocation, "bridgeId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "chat bridges stop",
    () => ({ method: "POST", path: `/api/chat-gateway/bridges/${encodeURIComponent(bridgeId)}/stop` }),
    () => connection.client.chatGateway.stopBridge(bridgeId),
  );
  if (!result) return;
  return { data: result, message: `Chat bridge \`${bridgeId}\` stopped (${result.running ? "running" : "stopped"}).` };
}

export async function chatBridgesRemove(context: CliContext, invocation: CliInvocation) {
  const bridgeId = requireArgument(invocation, "bridgeId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "chat bridges remove",
    () => ({ method: "DELETE", path: `/api/chat-gateway/bridges/${encodeURIComponent(bridgeId)}` }),
    () => connection.client.chatGateway.removeBridge(bridgeId),
  );
  if (!result) return;
  return { data: result, message: `Chat bridge \`${bridgeId}\` removed.` };
}

export async function chatSessionsList(context: CliContext) {
  const connection = await openConnection(context);
  const sessions = await connection.client.chatGateway.listSessions(context.signal);
  if (context.output.json) return { data: sessions };
  return { data: rows(sessions), columns: SESSION_COLUMNS, message: sessions.length ? undefined : "No chat sessions matched." };
}

export async function chatSessionsShow(context: CliContext, invocation: CliInvocation) {
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const session = await connection.client.chatGateway.getSession(sessionId, context.signal);
  if (context.output.json) return { data: session };
  return { data: session, columns: SESSION_COLUMNS };
}

export async function mobileSessionList(context: CliContext) {
  const connection = await openConnection(context);
  const sessions = await connection.client.auth.mobileSessions(context.signal);
  if (context.output.json) return { data: sessions };
  return { data: rows(sessions), columns: MOBILE_SESSION_COLUMNS, message: sessions.length ? undefined : "No mobile sessions matched." };
}

export async function mobileSessionRevoke(context: CliContext, invocation: CliInvocation) {
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "mobile-session revoke",
    () => ({ method: "DELETE", path: `/api/auth/mobile/sessions/${encodeURIComponent(sessionId)}` }),
    () => connection.client.auth.revokeMobileSession(sessionId),
  );
  if (!result) return;
  return { data: result, message: `Mobile session \`${sessionId}\` revoked.` };
}
