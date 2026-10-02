import { NODE_CAPABILITIES, requireInstanceNodeCapability } from "../capability.ts";
import { registerSecret } from "../redact.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readRequestBody, readTokenFromStdin, requireArgument, requireOption } from "./support.ts";

const TEMPLATE_COLUMNS = [
  { key: "id", header: "template" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

const CREDENTIAL_COLUMNS = [
  { key: "id", header: "credential" },
  { key: "name", header: "name", width: 24 },
  { key: "kind", header: "kind" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

const ASSIGNMENT_COLUMNS = [
  { key: "credentialId", header: "credential" },
  { key: "instanceId", header: "instance" },
  { key: "status", header: "status" },
  { key: "updatedAt", header: "updated" },
];

function rows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

/** `--token-stdin` 只补写 secret 字段，不允许主题字段走明文选项。 */
async function withOptionalToken(invocation: CliInvocation, body: Record<string, unknown>, apply: (body: Record<string, unknown>, token: string) => void) {
  if (invocation.options.tokenStdin !== true) return body;
  const token = await readTokenFromStdin(invocation);
  apply(body, token);
  return body;
}

export async function envTemplateList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const connection = await openConnection(context);
  const templates = await connection.client.environmentTemplates.listForNode(nodeId, context.signal);
  if (context.output.json) return { data: templates };
  return { data: rows(templates), columns: TEMPLATE_COLUMNS, message: templates.length ? undefined : "No environment templates matched." };
}

export async function envTemplateShow(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const templateId = requireArgument(invocation, "templateId");
  const connection = await openConnection(context);
  const template = await connection.client.environmentTemplates.get(nodeId, templateId, context.signal);
  if (context.output.json) return { data: template };
  return { data: template, columns: TEMPLATE_COLUMNS };
}

export async function envTemplateCreate(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const body = readRequestBody(invocation, "Environment template create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "env-template create",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/environment-templates`, body }),
    () => connection.client.environmentTemplates.createFromInstance(instanceId, body),
  );
  if (!result) return;
  return { data: result, columns: TEMPLATE_COLUMNS, message: `Environment template \`${result.id}\` created from \`${instanceId}\`.` };
}

export async function envTemplateRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const templateId = requireArgument(invocation, "templateId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "env-template remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/environment-templates/${encodeURIComponent(templateId)}` }),
    () => connection.client.environmentTemplates.remove(nodeId, templateId),
  );
  if (!result) return;
  return { data: result, message: `Environment template \`${templateId}\` removed from \`${nodeId}\`.` };
}

export async function gitCredentialList(context: CliContext) {
  const connection = await openConnection(context);
  const result = await connection.client.gitCredentials.listCredentials(context.signal);
  if (context.output.json) return { data: result };
  return { data: rows(result.items), columns: CREDENTIAL_COLUMNS, message: result.items.length ? undefined : "No git credentials matched." };
}

export async function gitCredentialShow(context: CliContext, invocation: CliInvocation) {
  const credentialId = requireArgument(invocation, "credentialId");
  const connection = await openConnection(context);
  const credential = await connection.client.gitCredentials.getCredential(credentialId, context.signal);
  if (context.output.json) return { data: credential };
  return { data: credential, columns: CREDENTIAL_COLUMNS };
}

export async function gitCredentialCreate(context: CliContext, invocation: CliInvocation) {
  const body = await withOptionalToken(invocation, readRequestBody(invocation, "Git credential create request"), (target, token) => {
    const secret = target.secret && typeof target.secret === "object" ? target.secret as Record<string, unknown> : {};
    target.secret = { ...secret, token };
  });
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "git-credential create",
    () => ({ method: "POST", path: "/api/git-credentials", body }),
    () => connection.client.gitCredentials.createCredential(body),
  );
  if (!result) return;
  return { data: result, columns: CREDENTIAL_COLUMNS, message: `Git credential \`${result.id}\` created.` };
}

export async function gitCredentialUpdate(context: CliContext, invocation: CliInvocation) {
  const credentialId = requireArgument(invocation, "credentialId");
  const body = await withOptionalToken(invocation, readRequestBody(invocation, "Git credential update request"), (target, token) => {
    const secret = target.secret && typeof target.secret === "object" ? target.secret as Record<string, unknown> : {};
    target.secret = { ...secret, token };
  });
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "git-credential update",
    () => ({ method: "PATCH", path: `/api/git-credentials/${encodeURIComponent(credentialId)}`, body }),
    () => connection.client.gitCredentials.updateCredential(credentialId, body),
  );
  if (!result) return;
  return { data: result, columns: CREDENTIAL_COLUMNS, message: `Git credential \`${credentialId}\` updated.` };
}

export async function gitCredentialRemove(context: CliContext, invocation: CliInvocation) {
  const credentialId = requireArgument(invocation, "credentialId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "git-credential remove",
    () => ({ method: "DELETE", path: `/api/git-credentials/${encodeURIComponent(credentialId)}` }),
    () => connection.client.gitCredentials.removeCredential(credentialId),
  );
  if (!result) return;
  return { data: result, message: `Git credential \`${credentialId}\` removed.` };
}

export async function gitCredentialAssignmentsList(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const connection = await openConnection(context);
  await requireInstanceNodeCapability(connection.client, instanceId, "git-credential assignments list", NODE_CAPABILITIES.managedGitCredentials, context.signal);
  const assignments = await connection.client.gitCredentials.listInstanceAssignments(instanceId, context.signal);
  if (context.output.json) return { data: assignments };
  return { data: rows(assignments), columns: ASSIGNMENT_COLUMNS, message: assignments.length ? undefined : "No git credential assignments matched." };
}

export async function gitCredentialAssign(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const credentialId = requireOption(invocation, "credential");
  const connection = await openConnection(context);
  await requireInstanceNodeCapability(connection.client, instanceId, "git-credential assignments assign", NODE_CAPABILITIES.managedGitCredentials, context.signal);
  const result = await performWrite(
    context,
    "git-credential assignments assign",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/git-credential-assignments`, body: { credentialId } }),
    () => connection.client.gitCredentials.assignToInstance(instanceId, { credentialId }),
  );
  if (!result) return;
  return { data: result, columns: ASSIGNMENT_COLUMNS, message: `Credential \`${credentialId}\` assigned to \`${instanceId}\`.` };
}

export async function gitCredentialUnassign(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const credentialId = requireArgument(invocation, "credentialId");
  const connection = await openConnection(context);
  await requireInstanceNodeCapability(connection.client, instanceId, "git-credential assignments unassign", NODE_CAPABILITIES.managedGitCredentials, context.signal);
  const result = await performWrite(
    context,
    "git-credential assignments unassign",
    () => ({ method: "DELETE", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/git-credential-assignments/${encodeURIComponent(credentialId)}` }),
    () => connection.client.gitCredentials.unassignFromInstance(instanceId, credentialId),
  );
  if (!result) return;
  return { data: result, message: `Credential \`${credentialId}\` unassigned from \`${instanceId}\`.` };
}

export { optionString };
