import fs from "node:fs";
import path from "node:path";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { usageError } from "../errors.ts";
import { readRequestBody, repeatableOption, requireArgument, requireOption } from "./support.ts";

const SETTINGS_COLUMNS = [
  { key: "publicBaseUrl", header: "public base url", width: 40 },
  { key: "updateChannel", header: "channel" },
  { key: "mentionTrigger", header: "mention" },
  { key: "commandTrigger", header: "command" },
  { key: "diagnosticLogs", header: "logs" },
];

const INVITE_COLUMNS = [
  { key: "id", header: "invite" },
  { key: "status", header: "status" },
  { key: "expiresAt", header: "expires" },
  { key: "createdAt", header: "created" },
];

const BINDING_COLUMNS = [
  { key: "id", header: "binding" },
  { key: "nodeId", header: "node" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

const CLAIM_COLUMNS = [
  { key: "id", header: "claim" },
  { key: "nodeId", header: "node" },
  { key: "status", header: "status" },
  { key: "expiresAt", header: "expires" },
];

const DIAGNOSTIC_COLUMNS = [
  { key: "bindingId", header: "binding" },
  { key: "activeHttp", header: "http" },
  { key: "activeStreams", header: "streams" },
  { key: "activeWebSockets", header: "websockets" },
];

function rows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

export async function controlPlaneStatus(context: CliContext) {
  const connection = await openConnection(context);
  const status = await connection.client.admin.status(context.signal);
  if (context.output.json) return { data: status };
  return {
    data: status,
    columns: [
      { key: "protocolVersion", header: "protocol" },
      { key: "build.version", header: "version" },
      { key: "storage.driver", header: "storage" },
    ],
  };
}

export async function controlPlaneSettingsShow(context: CliContext) {
  const connection = await openConnection(context);
  const settings = await connection.client.admin.getSettings(context.signal);
  if (context.output.json) return { data: settings };
  return { data: settings, columns: SETTINGS_COLUMNS };
}

export async function controlPlaneSettingsUpdate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Control Plane settings update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "control-plane settings update",
    () => ({ method: "PATCH", path: "/api/control-plane/settings", body }),
    () => connection.client.admin.updateSettings(body),
  );
  if (!result) return;
  return { data: result, columns: SETTINGS_COLUMNS, message: "Control Plane settings updated." };
}

export async function controlPlaneDiagnosticLogsExport(context: CliContext, invocation: CliInvocation) {
  const out = requireOption(invocation, "out");
  const connection = await openConnection(context);
  const download = await connection.client.admin.exportDiagnosticLogs();
  const target = path.resolve(out);
  try {
    fs.writeFileSync(target, download.body);
  } catch (error) {
    throw usageError("CLI_FILE_UNWRITABLE", `Cannot write \`${target}\`: ${error instanceof Error ? error.message : String(error)}`, { file: target });
  }
  return { data: { file: target, bytes: download.body.byteLength }, message: `Diagnostic logs written to \`${target}\` (${download.body.byteLength} bytes).` };
}

export async function cloudShow(context: CliContext) {
  const connection = await openConnection(context);
  const state = await connection.client.admin.cloudConnectivity(context.signal);
  if (context.output.json) return { data: state };
  return {
    data: state,
    columns: [
      { key: "status", header: "status" },
      { key: "serviceOrigin", header: "service", width: 40 },
      { key: "accountId", header: "account" },
      { key: "remoteAccessEnabled", header: "remote access" },
    ],
  };
}

export async function cloudChallenge(context: CliContext) {
  const connection = await openConnection(context);
  const challenge = await performWrite(
    context,
    "cloud challenge",
    () => ({ method: "POST", path: "/api/cloud-connectivity/challenges" }),
    () => connection.client.admin.createCloudChallenge(),
  );
  if (!challenge) return;
  // challengeCode 是绑定密钥，只存在于服务端与云服务之间；CLI 不打印、不落盘。
  return {
    data: {
      authorizationUrl: challenge.authorizationUrl,
      expiresAt: challenge.payload.expiresAt,
      publicKeyFingerprint: challenge.payload.publicKeyFingerprint,
    },
    message: `Cloud binding challenge created; open ${challenge.authorizationUrl} in the cloud console before ${challenge.payload.expiresAt}.`,
  };
}

export async function cloudRemoteAccess(context: CliContext, invocation: CliInvocation) {
  const enabled = parseBooleanOption(invocation, "enabled");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "cloud remote-access",
    () => ({ method: "POST", path: "/api/cloud-connectivity/remote-access", body: { enabled } }),
    () => connection.client.admin.setCloudRemoteAccess(enabled),
  );
  if (!result) return;
  return { data: result, message: `Cloud remote access ${enabled ? "enabled" : "disabled"}.` };
}

export async function cloudDisconnect(context: CliContext) {
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "cloud disconnect",
    () => ({ method: "POST", path: "/api/cloud-connectivity/disconnect" }),
    () => connection.client.admin.disconnectCloud(),
  );
  if (!result) return;
  return { data: result, message: `Cloud binding is now ${result.status}.` };
}

export async function proxyInvitesList(context: CliContext) {
  const connection = await openConnection(context);
  const invites = await connection.client.admin.proxyInvites(context.signal);
  if (context.output.json) return { data: invites };
  return { data: rows(invites), columns: INVITE_COLUMNS, message: invites.length ? undefined : "No proxy invites matched." };
}

export async function proxyInvitesCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Proxy invite create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "proxy invites create",
    () => ({ method: "POST", path: "/api/control-plane-proxy/invites", body }),
    () => connection.client.admin.createProxyInvite(body),
  );
  if (!result) return;
  return { data: result, columns: INVITE_COLUMNS, message: "Proxy invite created." };
}

export async function proxyInvitesRemove(context: CliContext, invocation: CliInvocation) {
  const inviteId = requireArgument(invocation, "inviteId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "proxy invites remove",
    () => ({ method: "DELETE", path: `/api/control-plane-proxy/invites/${encodeURIComponent(inviteId)}` }),
    () => connection.client.admin.revokeProxyInvite(inviteId),
  );
  if (!result) return;
  return { data: result, message: `Proxy invite \`${inviteId}\` revoked.` };
}

export async function proxyBindingsList(context: CliContext) {
  const connection = await openConnection(context);
  const bindings = await connection.client.admin.proxyBindings(context.signal);
  if (context.output.json) return { data: bindings };
  return { data: rows(bindings), columns: BINDING_COLUMNS, message: bindings.length ? undefined : "No proxy bindings matched." };
}

export async function proxyBindingsRemove(context: CliContext, invocation: CliInvocation) {
  const bindingId = requireArgument(invocation, "bindingId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "proxy bindings remove",
    () => ({ method: "DELETE", path: `/api/control-plane-proxy/bindings/${encodeURIComponent(bindingId)}` }),
    () => connection.client.admin.revokeProxyBinding(bindingId),
  );
  if (!result) return;
  return { data: result, message: `Proxy binding \`${bindingId}\` revoked.` };
}

export async function proxyDiagnostics(context: CliContext) {
  const connection = await openConnection(context);
  const diagnostics = await connection.client.admin.proxyDiagnostics(context.signal);
  if (context.output.json) return { data: diagnostics };
  return { data: rows(diagnostics), columns: DIAGNOSTIC_COLUMNS, message: diagnostics.length ? undefined : "No proxied bindings." };
}

export async function proxyPendingClaimsList(context: CliContext) {
  const connection = await openConnection(context);
  const claims = await connection.client.admin.pendingProxyClaims(context.signal);
  if (context.output.json) return { data: claims };
  return { data: rows(claims), columns: CLAIM_COLUMNS, message: claims.length ? undefined : "No pending proxy claims." };
}

export async function proxyPendingClaimsResume(context: CliContext, invocation: CliInvocation) {
  const claimId = requireArgument(invocation, "claimId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "proxy pending-claims resume",
    () => ({ method: "POST", path: `/api/control-plane-proxy/pending-claims/${encodeURIComponent(claimId)}/resume` }),
    () => connection.client.admin.resumeProxyClaim(claimId),
  );
  if (!result) return;
  return { data: result, message: `Pending proxy claim \`${claimId}\` resumed.` };
}

export async function proxyPendingClaimsRemove(context: CliContext, invocation: CliInvocation) {
  const claimId = requireArgument(invocation, "claimId");
  const force = invocation.options.force === true;
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "proxy pending-claims remove",
    () => ({ method: "DELETE", path: `/api/control-plane-proxy/pending-claims/${encodeURIComponent(claimId)}${force ? "?force=true" : ""}` }),
    () => connection.client.admin.cancelProxyClaim(claimId, force ? { force: true } : {}),
  );
  if (!result) return;
  return { data: result, message: `Pending proxy claim \`${claimId}\` cancelled.` };
}

function parseBooleanOption(invocation: CliInvocation, name: string) {
  const value = invocation.options[name];
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw usageError("CLI_OPTION_MISSING", `Missing required option --${name} <true|false>.`, { option: name });
}

export { repeatableOption };
