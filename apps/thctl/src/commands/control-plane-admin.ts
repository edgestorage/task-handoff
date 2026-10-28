import fs from "node:fs";
import path from "node:path";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { CLI_EXIT_CODES, ThctlError, usageError } from "../errors.ts";
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

const CLOUD_ACCOUNT_COLUMNS = [
  { key: "signedIn", header: "signed in" },
  { key: "email", header: "email", width: 36 },
  { key: "accountId", header: "account" },
  { key: "sessionExpiresAt", header: "expires" },
  { key: "pendingRequest.scope", header: "pending" },
];

const CLOUD_ACCOUNT_NODE_COLUMNS = [
  { key: "nodeHandle", header: "node handle", width: 32 },
  { key: "displayName", header: "name", width: 28 },
  { key: "status", header: "status" },
  { key: "access.kind", header: "access" },
  { key: "access.role", header: "role" },
  { key: "access.expiresAt", header: "expires" },
  { key: "revision", header: "revision" },
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

export async function cloudAccountShow(context: CliContext) {
  const connection = await openConnection(context);
  const account = await connection.client.admin.cloudAccount(context.signal);
  if (context.output.json) return { data: account };
  return {
    data: account,
    columns: CLOUD_ACCOUNT_COLUMNS,
    message: account.signedIn ? undefined : "No cloud account is signed in.",
  };
}

async function performCloudAuthorizationRequest<T extends { authorizationUrl: string }>(
  context: CliContext,
  commandId: string,
  path: string,
  execute: () => Promise<T>,
) {
  const request = await performWrite(
    context,
    commandId,
    () => ({ method: "POST", path }),
    execute,
  );
  if (!request) return;
  if (context.isTty && !context.output.json) {
    try {
      await context.openUrl(request.authorizationUrl);
    } catch {
      context.output.warn("Could not open a browser automatically; open the authorization URL manually.");
    }
  }
  return request;
}

export async function cloudAccountSignIn(context: CliContext) {
  const connection = await openConnection(context);
  const request = await performCloudAuthorizationRequest(
    context,
    "cloud account sign-in",
    "/api/cloud-account/sign-in-requests",
    () => connection.client.admin.createCloudSignInRequest(),
  );
  if (!request) return;
  return {
    data: request,
    message: `Open ${request.authorizationUrl} to sign in to the cloud account. This request expires at ${request.expiresAt}.`,
  };
}

export async function cloudAccountSignOut(context: CliContext) {
  const connection = await openConnection(context);
  const account = await performWrite(
    context,
    "cloud account sign-out",
    () => ({ method: "POST", path: "/api/cloud-account/sign-out" }),
    () => connection.client.admin.signOutCloudAccount(),
  );
  if (!account) return;
  return { data: account, columns: CLOUD_ACCOUNT_COLUMNS, message: "Cloud account signed out." };
}

export async function cloudBind(context: CliContext) {
  const connection = await openConnection(context);
  const request = await performCloudAuthorizationRequest(
    context,
    "cloud bind",
    "/api/cloud-connectivity/binding-requests",
    async () => {
      const account = await connection.client.admin.cloudAccount(context.signal);
      if (!account.signedIn) {
        throw new ThctlError(
          "CLOUD_ACCOUNT_SIGN_IN_REQUIRED",
          "Sign in to the cloud account before binding this Control Plane. Run `thctl cloud account sign-in` first.",
          CLI_EXIT_CODES.notAuthenticated,
        );
      }
      return connection.client.admin.createCloudBindingRequest();
    },
  );
  if (!request) return;
  return {
    data: request,
    message: `Open ${request.authorizationUrl} to approve this Control Plane's cloud binding. This request expires at ${request.expiresAt}.`,
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
  // The legacy wire field resets nodeRelay to false. Refuse to make that change
  // implicitly; callers that need both scopes use `cloud scopes set`.
  const current = await connection.client.admin.cloudConnectivity(context.signal);
  if (current.scopes.nodeRelay) {
    throw new ThctlError(
      "CLI_CLOUD_SCOPE_CONFLICT",
      "The legacy `cloud remote-access` command would disable node relay. Use `thctl cloud scopes set --device-access <true|false> --node-relay <true|false>` instead.",
      CLI_EXIT_CODES.conflict,
      { nodeRelay: true },
    );
  }
  const result = await performWrite(
    context,
    "cloud remote-access",
    () => ({ method: "POST", path: "/api/cloud-connectivity/remote-access", body: { enabled } }),
    () => connection.client.admin.setCloudRemoteAccess(enabled),
  );
  if (!result) return;
  return { data: result, message: `Cloud device access ${enabled ? "enabled" : "disabled"}; node relay remains disabled.` };
}

export async function cloudScopesSet(context: CliContext, invocation: CliInvocation) {
  const deviceAccess = parseBooleanOption(invocation, "device-access");
  const nodeRelay = parseBooleanOption(invocation, "node-relay");
  const scopes = { deviceAccess, nodeRelay };
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "cloud scopes set",
    () => ({ method: "POST", path: "/api/cloud-connectivity/remote-access", body: { scopes } }),
    () => connection.client.admin.setCloudScopes(scopes),
  );
  if (!result) return;
  return {
    data: result,
    message: `Cloud scopes set: device access ${deviceAccess ? "enabled" : "disabled"}, node relay ${nodeRelay ? "enabled" : "disabled"}.`,
  };
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

export async function cloudAccountNodesList(context: CliContext) {
  const connection = await openConnection(context);
  const nodes = await connection.client.admin.cloudAccountNodes(context.signal);
  if (context.output.json) return { data: nodes };
  return {
    data: nodes.items,
    columns: CLOUD_ACCOUNT_NODE_COLUMNS,
    message: nodes.signedIn
      ? (nodes.items.length ? undefined : "No cloud account nodes matched.")
      : "Sign in to the cloud account to list nodes.",
  };
}

export async function cloudAccountNodeClaim(context: CliContext, invocation: CliInvocation) {
  const nodeHandle = requireArgument(invocation, "nodeHandle");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "cloud account-nodes claim",
    () => ({ method: "POST", path: `/api/cloud-connectivity/account-nodes/${encodeURIComponent(nodeHandle)}/claim` }),
    () => connection.client.admin.claimCloudAccountNode(nodeHandle),
  );
  if (!result) return;
  return { data: result, message: `Cloud node \`${nodeHandle}\` claimed by this Control Plane.` };
}

export async function cloudAccountNodeRelease(context: CliContext, invocation: CliInvocation) {
  const nodeHandle = requireArgument(invocation, "nodeHandle");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "cloud account-nodes release",
    () => ({ method: "DELETE", path: `/api/cloud-connectivity/account-nodes/${encodeURIComponent(nodeHandle)}/claim` }),
    () => connection.client.admin.releaseCloudAccountNodeClaim(nodeHandle),
  );
  if (!result) return;
  return { data: result, message: `Cloud node \`${nodeHandle}\` claim released by this Control Plane.` };
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
