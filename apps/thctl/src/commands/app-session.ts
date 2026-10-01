import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, requireArgument } from "./support.ts";

const APP_SESSION_COLUMNS = [
  { key: "instanceId", header: "instance" },
  { key: "id", header: "app session" },
  { key: "appId", header: "app" },
  { key: "title", header: "title", width: 30 },
  { key: "kind", header: "kind" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

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
