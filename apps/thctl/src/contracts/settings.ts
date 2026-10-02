import { z } from "zod";
import { CustomImageProfileSchema, ProjectSchema, PublicModelConfigSchema as PublicModelSchema } from "@task-handoff/protocol/control-plane";
import { GitCredentialPublicSchema, InstanceGitCredentialAssignmentSchema } from "@task-handoff/protocol/managed-git-credentials";
import { ControlPlaneMobileSessionSchema } from "@task-handoff/protocol/control-plane-access";
import { emptyInput, group, inputOf, looseOutput, type CliGroup, type CliLeaf } from "./definition.ts";
import {
  imageCreate,
  imageList,
  imageOptions,
  imageRemove,
  imageShow,
  imageUpdate,
  marketCatalog,
  marketRefresh,
  modelCopy,
  modelCreate,
  modelDiscover,
  modelMerge,
  modelNodeCreate,
  modelNodeDiscover,
  modelNodeList,
  modelNodeRemove,
  modelNodeTest,
  modelNodeUpdate,
  modelRemove,
  modelReorder,
  modelSync,
  modelTest,
  modelUpdate,
  projectCreate,
  projectList,
  projectRemove,
  projectShow,
  projectUpdate,
} from "../commands/catalog.ts";
import {
  envTemplateCreate,
  envTemplateList,
  envTemplateRemove,
  envTemplateShow,
  gitCredentialAssign,
  gitCredentialAssignmentsList,
  gitCredentialCreate,
  gitCredentialList,
  gitCredentialRemove,
  gitCredentialShow,
  gitCredentialUnassign,
  gitCredentialUpdate,
} from "../commands/credentials.ts";
import {
  chatBridgesCreate,
  chatBridgesList,
  chatBridgesRemove,
  chatBridgesStart,
  chatBridgesStop,
  chatBridgesUpdate,
  chatSessionsList,
  chatSessionsShow,
  chatStatus,
  mobileSessionList,
  mobileSessionRevoke,
} from "../commands/chat.ts";
import {
  cloudChallenge,
  cloudDisconnect,
  cloudRemoteAccess,
  cloudShow,
  controlPlaneDiagnosticLogsExport,
  controlPlaneSettingsShow,
  controlPlaneSettingsUpdate,
  controlPlaneStatus,
  proxyBindingsList,
  proxyBindingsRemove,
  proxyDiagnostics,
  proxyInvitesCreate,
  proxyInvitesList,
  proxyInvitesRemove,
  proxyPendingClaimsList,
  proxyPendingClaimsRemove,
  proxyPendingClaimsResume,
} from "../commands/control-plane-admin.ts";

const configOption = { flags: "--config <file>", description: "Request body as a JSON file (Control Plane wire body)" };
const loose = { output: looseOutput, outputPinned: false } as const;

export const projectGroup = group("project", "Manage catalog projects", [
  { id: "project list", group: "project", name: "list", stage: "B", summary: "List projects", input: emptyInput, output: z.array(ProjectSchema), handler: projectList },
  {
    id: "project show", group: "project", name: "show", stage: "B", summary: "Show one project",
    args: [{ name: "projectId", description: "Project ID", required: true }],
    input: inputOf({ projectId: z.string() }), output: ProjectSchema, handler: projectShow,
  },
  {
    id: "project create", group: "project", name: "create", stage: "B", write: true, summary: "Create a project from a JSON request body",
    options: [configOption], input: inputOf({ config: z.string() }), output: ProjectSchema, handler: projectCreate,
  },
  {
    id: "project update", group: "project", name: "update", stage: "B", write: true, summary: "Update a project",
    args: [{ name: "projectId", description: "Project ID", required: true }],
    options: [configOption], input: inputOf({ projectId: z.string(), config: z.string() }), output: ProjectSchema, handler: projectUpdate,
  },
  {
    id: "project remove", group: "project", name: "remove", stage: "B", write: true, summary: "Remove a project",
    args: [{ name: "projectId", description: "Project ID", required: true }],
    input: inputOf({ projectId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: projectRemove,
  },
]);

export const imageGroup = group("image", "Manage custom images", [
  { id: "image list", group: "image", name: "list", stage: "B", summary: "List custom images", input: emptyInput, output: z.array(CustomImageProfileSchema), handler: imageList },
  {
    id: "image show", group: "image", name: "show", stage: "B", summary: "Show one image",
    args: [{ name: "imageId", description: "Image ID", required: true }],
    input: inputOf({ imageId: z.string() }), output: CustomImageProfileSchema, handler: imageShow,
  },
  {
    id: "image create", group: "image", name: "create", stage: "B", write: true, summary: "Create a custom image from a JSON request body",
    options: [configOption], input: inputOf({ config: z.string() }), output: CustomImageProfileSchema, handler: imageCreate,
  },
  {
    id: "image update", group: "image", name: "update", stage: "B", write: true, summary: "Update a custom image",
    args: [{ name: "imageId", description: "Image ID", required: true }],
    options: [configOption], input: inputOf({ imageId: z.string(), config: z.string() }), output: CustomImageProfileSchema, handler: imageUpdate,
  },
  {
    id: "image remove", group: "image", name: "remove", stage: "B", write: true, summary: "Remove a custom image",
    args: [{ name: "imageId", description: "Image ID", required: true }],
    input: inputOf({ imageId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: imageRemove,
  },
  { id: "image options", group: "image", name: "options", stage: "B", summary: "List selectable image options", input: emptyInput, ...loose, handler: imageOptions },
]);

export const marketGroup = group("market", "Inspect the market catalog", [
  { id: "market catalog", group: "market", name: "catalog", stage: "B", summary: "Show the market catalog snapshot", input: emptyInput, ...loose, handler: marketCatalog },
  { id: "market refresh", group: "market", name: "refresh", stage: "B", write: true, summary: "Refresh the market catalog from its source", input: emptyInput, ...loose, handler: marketRefresh },
]);

export const modelExtraLeaves: readonly CliLeaf[] = [
  {
    id: "model create", group: "model", name: "create", stage: "B", write: true, summary: "Create a model from a JSON request body",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: modelCreate,
  },
  {
    id: "model copy", group: "model", name: "copy", stage: "B", write: true, summary: "Copy a model",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    options: [configOption], input: inputOf({ modelId: z.string(), config: z.string() }), ...loose, handler: modelCopy,
  },
  {
    id: "model discover", group: "model", name: "discover", stage: "B", summary: "Discover models behind an endpoint",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: modelDiscover,
  },
  {
    id: "model test", group: "model", name: "test", stage: "B", summary: "Test a model endpoint",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: modelTest,
  },
  {
    id: "model reorder", group: "model", name: "reorder", stage: "B", write: true, summary: "Reorder models",
    options: [{ flags: "--id <modelId>", description: "Model entity ID in the new order", repeatable: true }],
    input: inputOf({ id: z.array(z.string()).optional() }), ...loose, handler: modelReorder,
  },
  {
    id: "model update", group: "model", name: "update", stage: "B", write: true, summary: "Update a model",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    options: [configOption], input: inputOf({ modelId: z.string(), config: z.string() }), ...loose, handler: modelUpdate,
  },
  {
    id: "model sync", group: "model", name: "sync", stage: "B", write: true, summary: "Sync a model to its assigned nodes",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    input: inputOf({ modelId: z.string() }), ...loose, handler: modelSync,
  },
  {
    id: "model merge", group: "model", name: "merge", stage: "B", write: true, summary: "Merge duplicate model entities",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    options: [configOption], input: inputOf({ modelId: z.string(), config: z.string() }), ...loose, handler: modelMerge,
  },
  {
    id: "model remove", group: "model", name: "remove", stage: "B", write: true, summary: "Remove a model",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    input: inputOf({ modelId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: modelRemove,
  },
  {
    id: "model node list", group: "model", name: "node list", stage: "B", summary: "List models deployed to a node",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    input: inputOf({ nodeId: z.string() }), output: z.array(PublicModelSchema), handler: modelNodeList,
  },
  {
    id: "model node create", group: "model", name: "node create", stage: "B", write: true, summary: "Deploy a model to a node",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    options: [configOption], input: inputOf({ nodeId: z.string(), config: z.string() }), ...loose, handler: modelNodeCreate,
  },
  {
    id: "model node update", group: "model", name: "node update", stage: "B", write: true, summary: "Update a node-scoped model",
    args: [
      { name: "nodeId", description: "Node ID", required: true },
      { name: "modelId", description: "Model entity ID", required: true },
    ],
    options: [configOption], input: inputOf({ nodeId: z.string(), modelId: z.string(), config: z.string() }), ...loose, handler: modelNodeUpdate,
  },
  {
    id: "model node remove", group: "model", name: "node remove", stage: "B", write: true, summary: "Remove a node-scoped model",
    args: [
      { name: "nodeId", description: "Node ID", required: true },
      { name: "modelId", description: "Model entity ID", required: true },
    ],
    input: inputOf({ nodeId: z.string(), modelId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: modelNodeRemove,
  },
  {
    id: "model node discover", group: "model", name: "node discover", stage: "B", summary: "Discover models from a node",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    options: [configOption], input: inputOf({ nodeId: z.string(), config: z.string() }), ...loose, handler: modelNodeDiscover,
  },
  {
    id: "model node test", group: "model", name: "node test", stage: "B", summary: "Test a node model endpoint",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    options: [configOption], input: inputOf({ nodeId: z.string(), config: z.string() }), ...loose, handler: modelNodeTest,
  },
];

export const envTemplateGroup = group("env-template", "Manage node environment templates", [
  {
    id: "env-template list", group: "env-template", name: "list", stage: "B", summary: "List environment templates for a node",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    input: inputOf({ nodeId: z.string() }), ...loose, handler: envTemplateList,
  },
  {
    id: "env-template show", group: "env-template", name: "show", stage: "B", summary: "Show one environment template",
    args: [
      { name: "nodeId", description: "Node ID", required: true },
      { name: "templateId", description: "Environment template ID", required: true },
    ],
    input: inputOf({ nodeId: z.string(), templateId: z.string() }), ...loose, handler: envTemplateShow,
  },
  {
    id: "env-template create", group: "env-template", name: "create", stage: "B", write: true, summary: "Create an environment template from an instance",
    args: [{ name: "instanceId", description: "Controlled instance ID", required: true }],
    options: [configOption], input: inputOf({ instanceId: z.string(), config: z.string() }), ...loose, handler: envTemplateCreate,
  },
  {
    id: "env-template remove", group: "env-template", name: "remove", stage: "B", write: true, summary: "Remove an environment template",
    args: [
      { name: "nodeId", description: "Node ID", required: true },
      { name: "templateId", description: "Environment template ID", required: true },
    ],
    input: inputOf({ nodeId: z.string(), templateId: z.string() }), ...loose, handler: envTemplateRemove,
  },
]);

export const gitCredentialGroup = group("git-credential", "Manage managed git credentials", [
  { id: "git-credential list", group: "git-credential", name: "list", stage: "B", summary: "List git credentials", input: emptyInput, output: z.looseObject({ items: z.array(GitCredentialPublicSchema) }), handler: gitCredentialList },
  {
    id: "git-credential show", group: "git-credential", name: "show", stage: "B", summary: "Show one git credential",
    args: [{ name: "credentialId", description: "Git credential ID", required: true }],
    input: inputOf({ credentialId: z.string() }), output: GitCredentialPublicSchema, handler: gitCredentialShow,
  },
  {
    id: "git-credential create", group: "git-credential", name: "create", stage: "B", write: true, summary: "Create a git credential from a JSON request body",
    options: [configOption], input: inputOf({ config: z.string() }), output: GitCredentialPublicSchema, handler: gitCredentialCreate,
  },
  {
    id: "git-credential update", group: "git-credential", name: "update", stage: "B", write: true, summary: "Update a git credential",
    args: [{ name: "credentialId", description: "Git credential ID", required: true }],
    options: [configOption], input: inputOf({ credentialId: z.string(), config: z.string() }), output: GitCredentialPublicSchema, handler: gitCredentialUpdate,
  },
  {
    id: "git-credential remove", group: "git-credential", name: "remove", stage: "B", write: true, summary: "Remove a git credential",
    args: [{ name: "credentialId", description: "Git credential ID", required: true }],
    input: inputOf({ credentialId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: gitCredentialRemove,
  },
  {
    id: "git-credential assignments list", group: "git-credential", name: "assignments list", stage: "B", summary: "List git credential assignments of an instance",
    args: [{ name: "instanceId", description: "Controlled instance ID", required: true }],
    input: inputOf({ instanceId: z.string() }), output: z.array(InstanceGitCredentialAssignmentSchema), handler: gitCredentialAssignmentsList,
  },
  {
    id: "git-credential assignments assign", group: "git-credential", name: "assignments assign", stage: "B", write: true, summary: "Assign a git credential to an instance",
    args: [{ name: "instanceId", description: "Controlled instance ID", required: true }],
    options: [{ flags: "--credential <credentialId>", description: "Git credential ID" }],
    input: inputOf({ instanceId: z.string(), credential: z.string() }), output: InstanceGitCredentialAssignmentSchema, handler: gitCredentialAssign,
  },
  {
    id: "git-credential assignments unassign", group: "git-credential", name: "assignments unassign", stage: "B", write: true, summary: "Unassign a git credential from an instance",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "credentialId", description: "Git credential ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), credentialId: z.string() }), output: z.looseObject({ revoked: z.boolean() }), handler: gitCredentialUnassign,
  },
]);

export const chatGroup = group("chat", "Manage the chat gateway", [
  { id: "chat status", group: "chat", name: "status", stage: "B", summary: "Show the chat gateway status", input: emptyInput, ...loose, handler: chatStatus },
  { id: "chat bridges list", group: "chat", name: "bridges list", stage: "B", summary: "List chat bridges", input: emptyInput, ...loose, handler: chatBridgesList },
  {
    id: "chat bridges create", group: "chat", name: "bridges create", stage: "B", write: true, summary: "Create a chat bridge from a JSON request body",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: chatBridgesCreate,
  },
  {
    id: "chat bridges update", group: "chat", name: "bridges update", stage: "B", write: true, summary: "Update a chat bridge",
    args: [{ name: "bridgeId", description: "Chat bridge ID", required: true }],
    options: [configOption], input: inputOf({ bridgeId: z.string(), config: z.string() }), ...loose, handler: chatBridgesUpdate,
  },
  {
    id: "chat bridges start", group: "chat", name: "bridges start", stage: "B", write: true, summary: "Start a chat bridge",
    args: [{ name: "bridgeId", description: "Chat bridge ID", required: true }],
    input: inputOf({ bridgeId: z.string() }), ...loose, handler: chatBridgesStart,
  },
  {
    id: "chat bridges stop", group: "chat", name: "bridges stop", stage: "B", write: true, summary: "Stop a chat bridge",
    args: [{ name: "bridgeId", description: "Chat bridge ID", required: true }],
    input: inputOf({ bridgeId: z.string() }), ...loose, handler: chatBridgesStop,
  },
  {
    id: "chat bridges remove", group: "chat", name: "bridges remove", stage: "B", write: true, summary: "Remove a chat bridge",
    args: [{ name: "bridgeId", description: "Chat bridge ID", required: true }],
    input: inputOf({ bridgeId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: chatBridgesRemove,
  },
  { id: "chat sessions list", group: "chat", name: "sessions list", stage: "B", summary: "List chat sessions", input: emptyInput, ...loose, handler: chatSessionsList },
  {
    id: "chat sessions show", group: "chat", name: "sessions show", stage: "B", summary: "Show one chat session",
    args: [{ name: "sessionId", description: "Chat session ID", required: true }],
    input: inputOf({ sessionId: z.string() }), ...loose, handler: chatSessionsShow,
  },
]);

export const mobileSessionGroup = group("mobile-session", "Manage mobile sessions", [
  { id: "mobile-session list", group: "mobile-session", name: "list", stage: "B", summary: "List mobile sessions", input: emptyInput, output: z.array(ControlPlaneMobileSessionSchema), handler: mobileSessionList },
  {
    id: "mobile-session revoke", group: "mobile-session", name: "revoke", stage: "B", write: true, summary: "Revoke a mobile session",
    args: [{ name: "sessionId", description: "Mobile session ID", required: true }],
    input: inputOf({ sessionId: z.string() }), output: z.looseObject({ revoked: z.boolean() }), handler: mobileSessionRevoke,
  },
]);

export const controlPlaneGroup = group("control-plane", "Inspect and configure the Control Plane", [
  { id: "control-plane status", group: "control-plane", name: "status", stage: "B", summary: "Show Control Plane status", input: emptyInput, ...loose, handler: controlPlaneStatus },
  { id: "control-plane settings show", group: "control-plane", name: "settings show", stage: "B", summary: "Show Control Plane settings", input: emptyInput, ...loose, handler: controlPlaneSettingsShow },
  {
    id: "control-plane settings update", group: "control-plane", name: "settings update", stage: "B", write: true, summary: "Update Control Plane settings",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: controlPlaneSettingsUpdate,
  },
  {
    id: "control-plane diagnostic-logs export", group: "control-plane", name: "diagnostic-logs export", stage: "B", summary: "Export diagnostic logs to a file",
    options: [{ flags: "--out <file>", description: "Destination file for the downloaded archive" }],
    input: inputOf({ out: z.string() }), output: z.looseObject({ file: z.string(), bytes: z.number() }), handler: controlPlaneDiagnosticLogsExport,
  },
]);

export const cloudGroup = group("cloud", "Manage the cloud connectivity binding", [
  { id: "cloud show", group: "cloud", name: "show", stage: "B", summary: "Show cloud connectivity state", input: emptyInput, ...loose, handler: cloudShow },
  { id: "cloud challenge", group: "cloud", name: "challenge", stage: "B", write: true, summary: "Create a cloud binding challenge (the challenge secret is never printed)", input: emptyInput, ...loose, handler: cloudChallenge },
  {
    id: "cloud remote-access", group: "cloud", name: "remote-access", stage: "B", write: true, summary: "Enable or disable cloud remote access",
    options: [{ flags: "--enabled <true|false>", description: "Whether remote access should be enabled" }],
    input: inputOf({ enabled: z.string() }), ...loose, handler: cloudRemoteAccess,
  },
  { id: "cloud disconnect", group: "cloud", name: "disconnect", stage: "B", write: true, summary: "Disconnect the cloud binding", input: emptyInput, ...loose, handler: cloudDisconnect },
]);

export const proxyGroup = group("proxy", "Manage the control-plane proxy", [
  { id: "proxy invites list", group: "proxy", name: "invites list", stage: "B", summary: "List proxy invites", input: emptyInput, ...loose, handler: proxyInvitesList },
  {
    id: "proxy invites create", group: "proxy", name: "invites create", stage: "B", write: true, summary: "Create a proxy invite",
    options: [configOption], input: inputOf({ config: z.string() }), ...loose, handler: proxyInvitesCreate,
  },
  {
    id: "proxy invites remove", group: "proxy", name: "invites remove", stage: "B", write: true, summary: "Revoke a proxy invite",
    args: [{ name: "inviteId", description: "Proxy invite ID", required: true }],
    input: inputOf({ inviteId: z.string() }), ...loose, handler: proxyInvitesRemove,
  },
  { id: "proxy bindings list", group: "proxy", name: "bindings list", stage: "B", summary: "List proxy bindings", input: emptyInput, ...loose, handler: proxyBindingsList },
  {
    id: "proxy bindings remove", group: "proxy", name: "bindings remove", stage: "B", write: true, summary: "Revoke a proxy binding",
    args: [{ name: "bindingId", description: "Proxy binding ID", required: true }],
    input: inputOf({ bindingId: z.string() }), ...loose, handler: proxyBindingsRemove,
  },
  { id: "proxy diagnostics", group: "proxy", name: "diagnostics", stage: "B", summary: "Show proxy stream diagnostics", input: emptyInput, ...loose, handler: proxyDiagnostics },
  { id: "proxy pending-claims list", group: "proxy", name: "pending-claims list", stage: "B", summary: "List pending proxy claims", input: emptyInput, ...loose, handler: proxyPendingClaimsList },
  {
    id: "proxy pending-claims resume", group: "proxy", name: "pending-claims resume", stage: "B", write: true, summary: "Resume a pending proxy claim",
    args: [{ name: "claimId", description: "Pending proxy claim ID", required: true }],
    input: inputOf({ claimId: z.string() }), ...loose, handler: proxyPendingClaimsResume,
  },
  {
    id: "proxy pending-claims remove", group: "proxy", name: "pending-claims remove", stage: "B", write: true, summary: "Cancel a pending proxy claim",
    args: [{ name: "claimId", description: "Pending proxy claim ID", required: true }],
    options: [{ flags: "--force", description: "Force cancellation of a claim that is mid-resume" }],
    input: inputOf({ claimId: z.string(), force: z.boolean().optional() }), ...loose, handler: proxyPendingClaimsRemove,
  },
]);

export const settingsGroups: readonly CliGroup[] = [
  projectGroup,
  imageGroup,
  marketGroup,
  envTemplateGroup,
  gitCredentialGroup,
  chatGroup,
  mobileSessionGroup,
  controlPlaneGroup,
  cloudGroup,
  proxyGroup,
];
