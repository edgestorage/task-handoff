import { z } from "zod";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, parseWithSchema, requireArgument } from "./support.ts";

const APP_SESSION_COLUMNS = [
  { key: "instanceId", header: "instance" },
  { key: "id", header: "app session" },
  { key: "appId", header: "app" },
  { key: "title", header: "title", width: 30 },
  { key: "kind", header: "kind" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

/** 与 client `RenameAppSessionInputSchema`、control-plane `AppSessionRenameRequestSchema` 对齐（trim + 1..120）。 */
const APP_SESSION_TITLE_SCHEMA = z.string().trim().min(1).max(120);

/** access 表格不设 width：url/token 被 … 截断后就不可用了。 */
const APP_SESSION_ACCESS_COLUMNS = [
  { key: "mode", header: "mode" },
  { key: "url", header: "url" },
  { key: "expiresAt", header: "expires" },
  { key: "token", header: "token" },
];

const appSessionRoute = (instanceId: string, appSessionId: string) =>
  `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(appSessionId)}`;

export async function appSessionList(context: CliContext, invocation: CliInvocation) {
  const instanceId = optionString(invocation, "instance");
  const connection = await openConnection(context);
  const view = await connection.client.appSessions.list(context.signal, instanceId);
  if (context.output.json) return { data: view };
  const rows = view.instances.flatMap((entry) => entry.appSessions.sessions.map((session) => ({
    ...session,
    instanceId: entry.instanceId,
  })));
  return { data: rows, columns: APP_SESSION_COLUMNS, message: rows.length ? undefined : "No app sessions matched." };
}

export async function appSessionShow(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appSessionId = requireArgument(invocation, "appSessionId");
  const connection = await openConnection(context);
  const view = await connection.client.appSessions.list(context.signal, instanceId);
  const session = view.instances
    .filter((entry) => entry.instanceId === instanceId)
    .flatMap((entry) => entry.appSessions.sessions)
    .find((candidate) => candidate.id === appSessionId);
  if (!session) {
    throw new ThctlError("CLI_APP_SESSION_NOT_FOUND", `No app session \`${appSessionId}\` is visible on instance \`${instanceId}\`.`, 7, { instanceId, appSessionId });
  }
  return { data: session, columns: APP_SESSION_COLUMNS };
}

export async function appSessionStart(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appId = requireArgument(invocation, "appId");
  const cwdFolderId = optionString(invocation, "cwd-folder");
  const input = { appId, ...(cwdFolderId ? { cwdFolderId } : {}) };
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "app-session start",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions`, body: input }),
    () => connection.client.appSessions.launch(instanceId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "app session" },
      { key: "appId", header: "app" },
      { key: "status", header: "status" },
    ],
    message: `App session \`${result.id}\` started.`,
  };
}

export async function appSessionStop(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appSessionId = requireArgument(invocation, "appSessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "app-session stop",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(appSessionId)}/stop`, body: {} }),
    () => connection.client.appSessions.stop(instanceId, appSessionId),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "app session" },
      { key: "status", header: "status" },
    ],
    message: `App session \`${appSessionId}\` is ${result.status}.`,
  };
}

export async function appSessionRename(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appSessionId = requireArgument(invocation, "appSessionId");
  const title = parseWithSchema(APP_SESSION_TITLE_SCHEMA, requireArgument(invocation, "title"), "title");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "app-session rename",
    () => ({ method: "PATCH", path: appSessionRoute(instanceId, appSessionId), body: { title } }),
    () => connection.client.appSessions.rename(instanceId, appSessionId, title),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "app session" },
      { key: "title", header: "title", width: 40 },
      { key: "status", header: "status" },
    ],
    message: `App session \`${result.id}\` renamed to \`${result.title ?? title}\`.`,
  };
}

export async function appSessionAccess(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appSessionId = requireArgument(invocation, "appSessionId");
  const connection = await openConnection(context);
  const lease = await performWrite(
    context,
    "app-session access",
    () => ({ method: "POST", path: `${appSessionRoute(instanceId, appSessionId)}/access`, body: {} }),
    () => connection.client.appSessions.access(instanceId, appSessionId),
  );
  if (!lease) return;
  // --json 保持服务端 wire 字段原样（url 为相对路径）；表格模式解析成已验证 origin 下的绝对地址，便于直接打开。
  if (context.output.json) return { data: lease };
  return {
    data: { ...lease, url: new URL(lease.url, connection.identity.origin).toString() },
    columns: APP_SESSION_ACCESS_COLUMNS,
    message: `${lease.mode.toUpperCase()} access lease expires at ${lease.expiresAt}.`,
  };
}

export async function appSessionRestart(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const appSessionId = requireArgument(invocation, "appSessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "app-session restart",
    () => ({ method: "POST", path: `${appSessionRoute(instanceId, appSessionId)}/restart`, body: {} }),
    () => connection.client.appSessions.restart(instanceId, appSessionId),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "app session" },
      { key: "appId", header: "app" },
      { key: "status", header: "status" },
    ],
    // 受控实例 restart = stop + start，返回记录的 id 是新会话 ID，必须提示新 ID。
    message: `App session \`${appSessionId}\` restarted as \`${result.id}\`.`,
  };
}
