import { CONTROL_PLANE_CAPABILITIES, requireControlPlaneCapability } from "../capability.ts";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readRequestBody, readTokenFromStdin, requireArgument } from "./support.ts";

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

const ROLE_COLUMNS = [
  { key: "id", header: "role" },
  { key: "name", header: "name", width: 24 },
  { key: "builtin", header: "builtin" },
  { key: "updatedAt", header: "updated" },
];

const PERMISSION_COLUMNS = [
  { key: "id", header: "permission" },
  { key: "description", header: "description", width: 48 },
];

const PROVIDER_COLUMNS = [
  { key: "id", header: "provider" },
  { key: "name", header: "name", width: 24 },
  { key: "kind", header: "kind" },
  { key: "enabled", header: "enabled" },
];

const APPROVAL_COLUMNS = [
  { key: "id", header: "approval" },
  { key: "displayName", header: "name", width: 24 },
  { key: "email", header: "email", width: 30 },
  { key: "status", header: "status" },
];

function tableRows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

async function gated(context: CliContext, commandId: string, capability: { name: string; check: (capabilities: unknown) => boolean }) {
  const connection = await openConnection(context);
  requireControlPlaneCapability(commandId, connection.identity, capability);
  return connection;
}

export async function userCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "User create request");
  const connection = await gated(context, "user create", CONTROL_PLANE_CAPABILITIES.userManagement);
  const result = await performWrite(
    context,
    "user create",
    () => ({ method: "POST", path: "/api/users", body }),
    () => connection.client.users.create(body),
  );
  if (!result) return;
  return { data: result, columns: USER_COLUMNS, message: `User \`${result.id}\` created.` };
}

export async function userUpdate(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const body = readRequestBody(invocation, "User update request");
  const connection = await gated(context, "user update", CONTROL_PLANE_CAPABILITIES.userManagement);
  const result = await performWrite(
    context,
    "user update",
    () => ({ method: "PATCH", path: `/api/users/${encodeURIComponent(userId)}`, body }),
    () => connection.client.users.update(userId, body as never),
  );
  if (!result) return;
  return { data: result, columns: USER_COLUMNS, message: `User \`${userId}\` updated.` };
}

export async function userAccess(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const body = readRequestBody(invocation, "User access request");
  const connection = await gated(context, "user access", CONTROL_PLANE_CAPABILITIES.userManagement);
  const result = await performWrite(
    context,
    "user access",
    () => ({ method: "PUT", path: `/api/users/${encodeURIComponent(userId)}/access`, body }),
    () => connection.client.users.setAccess(userId, body),
  );
  if (!result) return;
  return { data: result, columns: USER_COLUMNS, message: `Access for \`${userId}\` updated.` };
}

export async function userPasswordReset(context: CliContext, invocation: CliInvocation) {
  const userId = requireArgument(invocation, "userId");
  const password = await readTokenFromStdin(invocation);
  const requirePasswordChange = invocation.options["require-change"] === true;
  const connection = await gated(context, "user password-reset", CONTROL_PLANE_CAPABILITIES.userManagement);
  const body = { password, ...(requirePasswordChange ? { requirePasswordChange: true } : {}) };
  const result = await performWrite(
    context,
    "user password-reset",
    () => ({ method: "POST", path: `/api/users/${encodeURIComponent(userId)}/password-reset`, body }),
    () => connection.client.users.resetPassword(userId, body),
  );
  if (!result) return;
  return {
    data: result,
    columns: [{ key: "id", header: "user" }, { key: "primaryUsername", header: "username" }],
    message: `Password for \`${userId}\` reset.`,
  };
}

export async function userRoleList(context: CliContext) {
  const connection = await gated(context, "user role list", CONTROL_PLANE_CAPABILITIES.customRoles);
  const roles = await connection.client.users.roles(context.signal);
  if (context.output.json) return { data: roles };
  return { data: tableRows(roles), columns: ROLE_COLUMNS, message: roles.length ? undefined : "No roles matched." };
}

export async function userRoleCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Role create request");
  const connection = await gated(context, "user role create", CONTROL_PLANE_CAPABILITIES.customRoles);
  const result = await performWrite(
    context,
    "user role create",
    () => ({ method: "POST", path: "/api/roles", body }),
    () => connection.client.users.createRole(body),
  );
  if (!result) return;
  return { data: result, columns: ROLE_COLUMNS, message: `Role \`${result.id}\` created.` };
}

export async function userRoleUpdate(context: CliContext, invocation: CliInvocation) {
  const roleId = requireArgument(invocation, "roleId");
  const body = readRequestBody(invocation, "Role update request");
  const connection = await gated(context, "user role update", CONTROL_PLANE_CAPABILITIES.customRoles);
  const result = await performWrite(
    context,
    "user role update",
    () => ({ method: "PATCH", path: `/api/roles/${encodeURIComponent(roleId)}`, body }),
    () => connection.client.users.updateRole(roleId, body),
  );
  if (!result) return;
  return { data: result, columns: ROLE_COLUMNS, message: `Role \`${roleId}\` updated.` };
}

export async function userRoleRemove(context: CliContext, invocation: CliInvocation) {
  const roleId = requireArgument(invocation, "roleId");
  const connection = await gated(context, "user role remove", CONTROL_PLANE_CAPABILITIES.customRoles);
  const result = await performWrite(
    context,
    "user role remove",
    () => ({ method: "DELETE", path: `/api/roles/${encodeURIComponent(roleId)}` }),
    () => connection.client.users.archiveRole(roleId),
  );
  if (!result) return;
  return { data: result, message: `Role \`${roleId}\` archived.` };
}

export async function userPermissionList(context: CliContext) {
  const connection = await gated(context, "user permission list", CONTROL_PLANE_CAPABILITIES.customRoles);
  const permissions = await connection.client.users.permissions(context.signal);
  if (context.output.json) return { data: permissions };
  return { data: tableRows(permissions), columns: PERMISSION_COLUMNS, message: permissions.length ? undefined : "No permissions matched." };
}

export async function userIdentityProviderList(context: CliContext) {
  const connection = await gated(context, "user identity-provider list", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const providers = await connection.client.users.providers(context.signal);
  if (context.output.json) return { data: providers };
  return { data: tableRows(providers), columns: PROVIDER_COLUMNS, message: providers.length ? undefined : "No identity providers matched." };
}

export async function userIdentityProviderCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Identity provider create request");
  const connection = await gated(context, "user identity-provider create", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const result = await performWrite(
    context,
    "user identity-provider create",
    () => ({ method: "POST", path: "/api/identity-providers", body }),
    () => connection.client.users.createProvider(body),
  );
  if (!result) return;
  return { data: result, columns: PROVIDER_COLUMNS, message: `Identity provider \`${result.id}\` created.` };
}

export async function userIdentityProviderUpdate(context: CliContext, invocation: CliInvocation) {
  const providerId = requireArgument(invocation, "providerId");
  const body = readRequestBody(invocation, "Identity provider update request");
  const connection = await gated(context, "user identity-provider update", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const result = await performWrite(
    context,
    "user identity-provider update",
    () => ({ method: "PATCH", path: `/api/identity-providers/${encodeURIComponent(providerId)}`, body }),
    () => connection.client.users.updateProvider(providerId, body),
  );
  if (!result) return;
  return { data: result, columns: PROVIDER_COLUMNS, message: `Identity provider \`${providerId}\` updated.` };
}

export async function userIdentityProviderRemove(context: CliContext, invocation: CliInvocation) {
  const providerId = requireArgument(invocation, "providerId");
  const connection = await gated(context, "user identity-provider remove", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const result = await performWrite(
    context,
    "user identity-provider remove",
    () => ({ method: "DELETE", path: `/api/identity-providers/${encodeURIComponent(providerId)}` }),
    () => connection.client.users.removeProvider(providerId),
  );
  if (!result) return;
  return { data: result, message: `Identity provider \`${providerId}\` removed.` };
}

export async function userExternalIdentityList(context: CliContext) {
  const connection = await gated(context, "user external-identity list", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const approvals = await connection.client.users.approvals(context.signal);
  if (context.output.json) return { data: approvals };
  return { data: tableRows(approvals), columns: APPROVAL_COLUMNS, message: approvals.length ? undefined : "No pending identity approvals." };
}

export async function userExternalIdentityApprove(context: CliContext, invocation: CliInvocation) {
  const approvalId = requireArgument(invocation, "approvalId");
  const config = optionString(invocation, "config");
  const body = config ? readRequestBody(invocation, "Identity approval request") : {};
  const connection = await gated(context, "user external-identity approve", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const result = await performWrite(
    context,
    "user external-identity approve",
    () => ({ method: "POST", path: `/api/external-identity-approvals/${encodeURIComponent(approvalId)}/approve`, body }),
    () => connection.client.users.approveIdentity(approvalId, body),
  );
  if (!result) return;
  return { data: result, columns: USER_COLUMNS, message: `Identity approval \`${approvalId}\` approved.` };
}

export async function userExternalIdentityReject(context: CliContext, invocation: CliInvocation) {
  const approvalId = requireArgument(invocation, "approvalId");
  const connection = await gated(context, "user external-identity reject", CONTROL_PLANE_CAPABILITIES.externalIdentityLogin);
  const result = await performWrite(
    context,
    "user external-identity reject",
    () => ({ method: "POST", path: `/api/external-identity-approvals/${encodeURIComponent(approvalId)}/reject`, body: {} }),
    () => connection.client.users.rejectIdentity(approvalId),
  );
  if (!result) return;
  return { data: result, message: `Identity approval \`${approvalId}\` rejected.` };
}
