import { z } from "zod";
import {
  GitCredentialPublicSchema,
  GitWorkspaceProvisioningInputSchema,
  InstanceGitCredentialAssignmentSchema,
} from "@task-handoff/protocol/managed-git-credentials";
import { SecretEnvelopeSchema } from "../secret-envelope.ts";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().datetime();
const LabelsSchema = z.record(z.string(), z.string());

const NodeConnectionPathRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z.object({
    kind: z.literal("control-plane-proxy"),
    proxyId: IdSchema,
    proxyBindingId: IdSchema,
    targetNodeId: IdSchema,
  }).strict(),
]);

export const NodeConfigRecordSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  connectionMode: z.enum(["local-ipc", "local-loopback", "direct-http", "reverse-wss", "control-plane-proxy"]),
  connectionPath: NodeConnectionPathRecordSchema,
  connectionEnabled: z.boolean(),
  authMode: z.enum(["local-static-key", "paired-hmac", "proxy-binding"]),
  authKeyId: IdSchema.optional(),
  authSecretCiphertext: SecretEnvelopeSchema.optional(),
  authPairedAt: TimestampSchema.optional(),
  authPairingStatus: z.enum(["paired", "expired"]).optional(),
  endpoint: z.string().trim().max(2048).optional(),
  controlEndpoint: z.string().trim().max(2048).optional(),
  containerEndpoint: z.string().trim().max(2048).optional(),
  publicWebBase: z.string().trim().max(2048).optional(),
  labels: LabelsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const PairingRevokeRecordSchema = z.object({
  id: IdSchema,
  endpoint: z.string().trim().min(1).max(2048),
  nodeId: IdSchema,
  keyId: IdSchema,
  secretCiphertext: SecretEnvelopeSchema,
  pairedAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  phase: z.enum(["pending-compensation", "compensating"]).default("pending-compensation"),
}).strict();

export const ModelRecordSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  endpoint: z.string().trim().min(1).max(2048),
  keyCiphertext: SecretEnvelopeSchema,
  model: z.string().trim().min(1).max(240),
  modelNames: z.array(z.object({ name: z.string().trim().min(1).max(240), order: z.number().int().nonnegative() }).strict()).max(256),
  protocols: z.array(z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages"])).max(3),
  app: z.enum(["codex", "claude", "opencode"]),
  enabled: z.boolean(),
  order: z.number().int().nonnegative(),
  labels: LabelsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const ChatBridgeRecordSchema = z.object({
  id: IdSchema,
  channel: z.enum(["web", "telegram", "wechat", "dingding", "lark"]),
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  credentialCiphertext: SecretEnvelopeSchema.optional(),
  credentialMetadata: z.object({
    tokenSet: z.boolean(),
    clientSecretSet: z.boolean(),
    appSecretSet: z.boolean(),
  }).strict().default({ tokenSet: false, clientSecretSet: false, appSecretSet: false }),
  defaultChatId: z.string().trim().max(240).optional(),
  allowedUserIds: z.array(z.string().trim().min(1).max(240)),
  pollIntervalMs: z.number().int().positive().max(60_000),
  settings: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const ChatSessionRecordSchema = z.object({
  id: IdSchema,
  routeScope: z.string().trim().min(1).max(300),
  channel: z.enum(["web", "telegram", "wechat", "dingding", "lark"]),
  bridgeId: IdSchema.optional(),
  chatSessionId: z.string().trim().min(1).max(240),
  userId: z.string().trim().max(240).optional(),
  activeProjectId: IdSchema.optional(),
  activeInstanceId: IdSchema.optional(),
  activeAiSessionId: z.string().trim().min(1).max(120).optional(),
  lastUsedAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const GitCredentialRecordSchema = z.object({
  id: GitCredentialPublicSchema.shape.id,
  name: GitCredentialPublicSchema.shape.name,
  kind: GitCredentialPublicSchema.shape.kind,
  scope: GitCredentialPublicSchema.shape.scope,
  status: GitCredentialPublicSchema.shape.status,
  revision: GitCredentialPublicSchema.shape.revision,
  secretCiphertext: SecretEnvelopeSchema,
  createdAt: GitCredentialPublicSchema.shape.createdAt,
  updatedAt: GitCredentialPublicSchema.shape.updatedAt,
}).strict();

export const GitAssignmentRecordSchema = InstanceGitCredentialAssignmentSchema.extend({
  id: IdSchema,
  createdAt: TimestampSchema,
}).strict();

export const GitProvisioningIntentRecordSchema = z.object({
  id: IdSchema,
  instanceId: IdSchema,
  credentialId: GitCredentialPublicSchema.shape.id,
  operationId: GitWorkspaceProvisioningInputSchema.shape.operationId,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  remoteUrl: GitWorkspaceProvisioningInputSchema.shape.remoteUrl,
  ref: GitWorkspaceProvisioningInputSchema.shape.ref,
  clone: GitWorkspaceProvisioningInputSchema.shape.clone,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const GitAuditRecordSchema = z.object({
  id: IdSchema,
  action: z.enum(["create", "update", "delete", "authorize", "assignment-status", "revoke"]),
  credentialId: GitCredentialPublicSchema.shape.id,
  instanceId: IdSchema.optional(),
  credentialRevision: GitCredentialPublicSchema.shape.revision.optional(),
  assignmentRevision: GitCredentialPublicSchema.shape.revision.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export type NodeConfigRecord = z.infer<typeof NodeConfigRecordSchema>;
export type PairingRevokeRecord = z.infer<typeof PairingRevokeRecordSchema>;
export type ModelRecord = z.infer<typeof ModelRecordSchema>;
export type ChatBridgeRecord = z.infer<typeof ChatBridgeRecordSchema>;
export type ChatSessionRecord = z.infer<typeof ChatSessionRecordSchema>;
export type GitCredentialRecord = z.infer<typeof GitCredentialRecordSchema>;
export type GitAssignmentRecord = z.infer<typeof GitAssignmentRecordSchema>;
export type GitProvisioningIntentRecord = z.infer<typeof GitProvisioningIntentRecordSchema>;
export type GitAuditRecord = z.infer<typeof GitAuditRecordSchema>;

export const p0RecordSchemas = {
  nodes: NodeConfigRecordSchema,
  pairingRevocations: PairingRevokeRecordSchema,
  models: ModelRecordSchema,
  chatBridges: ChatBridgeRecordSchema,
  chatSessions: ChatSessionRecordSchema,
  gitCredentials: GitCredentialRecordSchema,
  gitAssignments: GitAssignmentRecordSchema,
  gitProvisioningIntents: GitProvisioningIntentRecordSchema,
  gitAudit: GitAuditRecordSchema,
} as const;
