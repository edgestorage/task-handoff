import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ChatBridgeConfigSchema,
  ChatSessionBindingSchema,
  ModelConfigSchema,
  NodeSchema,
  sanitizeStoredNode,
  type ChatBridgeConfig,
  type ChatSessionBinding,
  type ModelConfig,
  type Node,
} from "@task-handoff/protocol/control-plane";
import {
  GitCredentialPublicSchema,
  GitCredentialSecretInputSchema,
  GitWorkspaceProvisioningInputSchema,
  InstanceGitCredentialAssignmentSchema,
  type GitCredentialSecretInput,
} from "@task-handoff/protocol/managed-git-credentials";
import { normalizeModel } from "../../public-records.ts";
import { PendingPairingRevokeSchema, type PendingPairingRevoke } from "../../nodes/connection-manager.ts";
import { LegacyControlPlaneSecretReader } from "../legacy-secret-reader.ts";
import { ControlPlaneNodeRepository, ControlPlanePairingRevokeRepository } from "../../nodes/repository.ts";
import { ControlPlaneModelRepository } from "../../models/repository.ts";
import { splitChatBridgeCredential } from "../../chat/bridges/credential-codec.ts";
import { chatSessionBindingId } from "../../chat/bridges/records.ts";
import { ControlPlaneChatRepository } from "../../chat/bridges/repository.ts";
import { ControlPlaneGitRepository, gitProvisioningInputDigest } from "../../git-credentials/repository.ts";
import type { ControlPlaneStorePaths } from "../paths.ts";
import type { SecretEnvelopeService } from "../secret-envelope.ts";
import type { ControlPlaneDatabase } from "./index.ts";
import { GitAssignmentRecordSchema, GitAuditRecordSchema, GitProvisioningIntentRecordSchema } from "./p0-records.ts";

const APPLICATION_MIGRATION_ID = "app_0001_import_v0.0.28_p0_json";
const APPLICATION_MIGRATION_CHECKSUM = crypto.createHash("sha256").update("control-plane-p0-json-import:v1").digest("hex");

// Compatibility for v0.0.28: this schema only reads the retired Managed Git
// JSON envelope so the one-time application migration can re-encrypt it.
const LegacyGitCredentialSchema = z.object({
  id: GitCredentialPublicSchema.shape.id,
  name: GitCredentialPublicSchema.shape.name,
  kind: GitCredentialPublicSchema.shape.kind,
  scope: GitCredentialPublicSchema.shape.scope,
  status: GitCredentialPublicSchema.shape.status,
  revision: GitCredentialPublicSchema.shape.revision,
  secretCiphertext: z.string().min(1).max(256 * 1024),
  createdAt: GitCredentialPublicSchema.shape.createdAt,
  updatedAt: GitCredentialPublicSchema.shape.updatedAt,
}).strip();

type LegacyGitCredential = z.infer<typeof LegacyGitCredentialSchema> & { secret: GitCredentialSecretInput };

export type LegacyP0MigrationPlan = {
  sourceDigest: string;
  sources: Array<{ domain: string; file: string; recordId: string; relatedIds: string[] }>;
  warnings: Array<{ domain: string; recordId?: string; field: string }>;
  nodes: Node[];
  pairingRevocations: PendingPairingRevoke[];
  models: ModelConfig[];
  chatBridges: ChatBridgeConfig[];
  chatSessions: ChatSessionBinding[];
  gitCredentials: LegacyGitCredential[];
  gitAssignments: z.infer<typeof GitAssignmentRecordSchema>[];
  gitProvisioningIntents: z.infer<typeof GitProvisioningIntentRecordSchema>[];
  gitAudit: z.infer<typeof GitAuditRecordSchema>[];
};

type SourceEntry = { domain: string; filePath: string; raw: unknown };

// Compatibility for v0.0.28: these are the only relationship identifiers
// retained in migration diagnostics. Values that may contain credentials or
// endpoint secrets are deliberately excluded.
function sourceReference(entry: SourceEntry) {
  const record = entry.raw as Record<string, unknown>;
  const relatedIds = ["nodeId", "bridgeId", "instanceId", "credentialId"]
    .map((field) => record[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    domain: entry.domain,
    file: path.basename(entry.filePath),
    recordId: String(record.id),
    relatedIds: [...new Set(relatedIds)].sort(),
  };
}

function migrationError(code: string, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, statusCode: 500, details });
}

function jsonEntries(directory: string, domain: string): SourceEntry[] {
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw migrationError("CONTROL_PLANE_P0_MIGRATION_SOURCE_INVALID", "Legacy P0 migration source is not a private directory.", { domain });
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const filePath = path.join(directory, name);
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) { throw migrationError("CONTROL_PLANE_P0_MIGRATION_JSON_INVALID", "Legacy P0 JSON could not be parsed.", { domain, file: name }, error); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { id?: unknown }).id !== "string") {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_RECORD_INVALID", "Legacy P0 record does not contain an id.", { domain, file: name });
    }
    if (name !== `${(raw as { id: string }).id}.json`) {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT", "Legacy P0 filename does not match its record id.", { domain, file: name, recordId: (raw as { id: string }).id });
    }
    return { domain, filePath, raw };
  });
}

function parseEntry<T>(entry: SourceEntry, schema: z.ZodType<T>, candidate: unknown = entry.raw): T {
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  throw migrationError("CONTROL_PLANE_P0_MIGRATION_RECORD_INVALID", "Legacy P0 record failed validation.", {
    domain: entry.domain,
    file: path.basename(entry.filePath),
    recordId: (entry.raw as { id?: unknown }).id,
    issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })),
  });
}

function pick(input: unknown, fields: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

function warningForUnknown(entry: SourceEntry, fields: string[], warnings: LegacyP0MigrationPlan["warnings"]) {
  const source = entry.raw as Record<string, unknown>;
  const known = new Set(fields);
  for (const field of Object.keys(source)) {
    if (!known.has(field)) warnings.push({ domain: entry.domain, recordId: String(source.id || ""), field });
  }
}

function uniqueIds(domain: string, records: Array<{ id: string }>) {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw migrationError("CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT", "Legacy P0 data contains duplicate record ids.", { domain, recordId: record.id });
    seen.add(record.id);
  }
}

// Compatibility for v0.0.28: this is the sole reader for the retired P0 JSON
// stores. Current services must never call it for per-record fallback.
export function planLegacyP0Migration(paths: ControlPlaneStorePaths): LegacyP0MigrationPlan {
  const warnings: LegacyP0MigrationPlan["warnings"] = [];
  const sources = {
    nodes: jsonEntries(paths.nodesDir, "nodes"),
    pairingRevocations: jsonEntries(paths.pendingPairingRevokesDir, "pairing-revocations"),
    models: jsonEntries(paths.modelsDir, "models"),
    chatBridges: jsonEntries(paths.chatBridgesDir, "chat-bridges"),
    chatSessions: jsonEntries(paths.chatSessionsDir, "chat-sessions"),
    gitCredentials: jsonEntries(paths.gitCredentialsDir, "git-credentials"),
    gitAssignments: jsonEntries(paths.gitCredentialAssignmentsDir, "git-assignments"),
    gitProvisioningIntents: jsonEntries(paths.gitCredentialProvisioningIntentsDir, "git-provisioning-intents"),
    gitAudit: jsonEntries(paths.gitCredentialAuditDir, "git-audit"),
  };
  const allEntries = Object.values(sources).flat();
  const sourceReferences = allEntries.map(sourceReference);
  const sourceDigest = crypto.createHash("sha256").update(JSON.stringify(allEntries.map((entry) => ({
    domain: entry.domain,
    file: path.basename(entry.filePath),
    raw: entry.raw,
  })))).digest("hex");

  const nodeFields = ["id", "name", "connectionMode", "connectionPath", "connectionEnabled", "auth", "endpoint", "controlEndpoint", "containerEndpoint", "publicWebBase", "status", "health", "capabilities", "proxyState", "appInventory", "labels", "lastSeenAt", "createdAt", "updatedAt"];
  const nodes = sources.nodes.map((entry) => {
    warningForUnknown(entry, nodeFields, warnings);
    return parseEntry(entry, NodeSchema, sanitizeStoredNode(entry.raw));
  });
  const pairingRevocations = sources.pairingRevocations.map((entry) => parseEntry(entry, PendingPairingRevokeSchema, pick(entry.raw, Object.keys(PendingPairingRevokeSchema.shape))));

  const modelFields = ["id", "name", "endpoint", "key", "model", "modelNames", "protocols", "app", "apps", "enabled", "order", "labels", "createdAt", "updatedAt"];
  const models = sources.models.map((entry) => {
    warningForUnknown(entry, modelFields, warnings);
    try { return ModelConfigSchema.parse(normalizeModel(pick(entry.raw, modelFields))); }
    catch (error) { throw migrationError("CONTROL_PLANE_P0_MIGRATION_RECORD_INVALID", "Legacy Model record failed validation.", { domain: entry.domain, file: path.basename(entry.filePath), recordId: (entry.raw as { id?: unknown }).id }, error); }
  });

  const bridgeFields = Object.keys(ChatBridgeConfigSchema.shape);
  const chatBridges = sources.chatBridges.map((entry) => {
    warningForUnknown(entry, bridgeFields, warnings);
    const bridge = parseEntry(entry, ChatBridgeConfigSchema, pick(entry.raw, bridgeFields));
    splitChatBridgeCredential(bridge);
    return bridge;
  });
  const sessionFields = Object.keys(ChatSessionBindingSchema.shape);
  const chatSessions = sources.chatSessions.map((entry) => {
    warningForUnknown(entry, sessionFields, warnings);
    return parseEntry(entry, ChatSessionBindingSchema, pick(entry.raw, sessionFields));
  });

  let legacyGitSecrets: LegacyControlPlaneSecretReader | undefined;
  if (sources.gitCredentials.length) {
    try { legacyGitSecrets = new LegacyControlPlaneSecretReader(paths.gitCredentialEncryptionKeyPath, "Git credential"); }
    catch (error) { throw migrationError("CONTROL_PLANE_P0_MIGRATION_KEYSTORE_MISSING", "Legacy Git credential keystore is missing.", { domain: "git-credentials" }, error); }
  }
  const gitCredentials = sources.gitCredentials.map((entry) => {
    const legacy = parseEntry(entry, LegacyGitCredentialSchema);
    try {
      return { ...legacy, secret: GitCredentialSecretInputSchema.parse(JSON.parse(legacyGitSecrets!.open(legacy.secretCiphertext))) };
    } catch (error) {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_SECRET_INVALID", "Legacy Git credential secret could not be authenticated.", { domain: entry.domain, recordId: legacy.id }, error);
    }
  });
  const gitAssignments = sources.gitAssignments.map((entry) => parseEntry(entry, GitAssignmentRecordSchema, pick(entry.raw, Object.keys(GitAssignmentRecordSchema.shape))));
  const gitProvisioningIntents = sources.gitProvisioningIntents.map((entry) => {
    const candidate = pick(entry.raw, ["id", "instanceId", "credentialId", "operationId", "remoteUrl", "ref", "clone", "createdAt", "updatedAt"]) as Record<string, unknown>;
    candidate.operationId ||= candidate.instanceId;
    candidate.inputDigest = gitProvisioningInputDigest(candidate as any);
    return parseEntry(entry, GitProvisioningIntentRecordSchema, candidate);
  });
  const gitAudit = sources.gitAudit.map((entry) => parseEntry(entry, GitAuditRecordSchema, pick(entry.raw, Object.keys(GitAuditRecordSchema.shape))));

  for (const [domain, records] of Object.entries({ nodes, pairingRevocations, models, chatBridges, chatSessions, gitCredentials, gitAssignments, gitProvisioningIntents, gitAudit })) uniqueIds(domain, records);
  const bridgeIds = new Set(chatBridges.map((bridge) => bridge.id));
  for (const session of chatSessions) {
    if (session.bridgeId && !bridgeIds.has(session.bridgeId)) throw migrationError("CONTROL_PLANE_P0_MIGRATION_ORPHAN_REFERENCE", "Legacy Chat session references a missing bridge.", { domain: "chat-sessions", recordId: session.id, bridgeId: session.bridgeId });
  }
  const credentialIds = new Set(gitCredentials.map((credential) => credential.id));
  for (const reference of [...gitAssignments, ...gitProvisioningIntents]) {
    if (!credentialIds.has(reference.credentialId)) throw migrationError("CONTROL_PLANE_P0_MIGRATION_ORPHAN_REFERENCE", "Legacy Managed Git record references a missing credential.", { domain: "managed-git", recordId: reference.id, credentialId: reference.credentialId });
  }
  const routeIds = new Set<string>();
  for (const session of chatSessions) {
    const routeId = chatSessionBindingId(session.channel, session.chatSessionId, session.bridgeId);
    if (session.id !== routeId || routeIds.has(routeId)) {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT", "Legacy Chat session route identity is inconsistent or duplicated.", {
        domain: "chat-sessions", recordId: session.id, bridgeId: session.bridgeId, routeId,
      });
    }
    routeIds.add(routeId);
  }
  const credentialRevisions = new Map(gitCredentials.map((credential) => [credential.id, credential.revision]));
  for (const assignment of gitAssignments) {
    const expectedId = `${assignment.instanceId}:${assignment.credentialId}`;
    if (assignment.id !== expectedId || assignment.credentialRevision > (credentialRevisions.get(assignment.credentialId) || 0)) {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT", "Legacy Git assignment identity or revision is inconsistent.", {
        domain: "git-assignments", recordId: assignment.id, instanceId: assignment.instanceId, credentialId: assignment.credentialId,
      });
    }
  }
  return { sourceDigest, sources: sourceReferences, warnings, nodes, pairingRevocations, models, chatBridges, chatSessions, gitCredentials, gitAssignments, gitProvisioningIntents, gitAudit };
}

export async function importLegacyP0Json(
  database: ControlPlaneDatabase,
  secrets: SecretEnvelopeService,
  paths: ControlPlaneStorePaths,
  options: { archive?: boolean; now?: () => Date; onWarning?: (warning: Record<string, unknown>) => void } = {},
) {
  const plan = planLegacyP0Migration(paths);
  const previous = await database.migration(APPLICATION_MIGRATION_ID);
  if (previous) {
    if (previous.checksum !== APPLICATION_MIGRATION_CHECKSUM) throw migrationError("CONTROL_PLANE_P0_MIGRATION_CHECKSUM_MISMATCH", "P0 application migration checksum does not match.");
    if (previous.details.sourceDigest !== plan.sourceDigest && legacySourcesPresent(paths)) {
      throw migrationError("CONTROL_PLANE_P0_MIGRATION_SOURCE_CONFLICT", "Legacy P0 JSON changed after database migration.", { expectedSourceDigest: previous.details.sourceDigest, actualSourceDigest: plan.sourceDigest });
    }
    if (options.archive !== false) archiveLegacyP0Sources(paths, options);
    return { imported: false, plan };
  }

  const targetCounts = await Promise.all([
    database.nodes.list(), database.pairingRevocations.list(), database.models.list(), database.chatBridges.list(), database.chatSessions.list(),
    database.gitCredentials.list(), database.gitAssignments.list(), database.gitProvisioningIntents.list(), database.gitAudit.list(),
  ]);
  if (targetCounts.some((records) => records.length)) throw migrationError("CONTROL_PLANE_P0_MIGRATION_TARGET_NOT_EMPTY", "P0 database tables are not empty and have no completed import ledger.");

  const appliedAt = (options.now?.() || new Date()).toISOString();
  await database.transaction(async (transaction) => {
    const nodeRepository = new ControlPlaneNodeRepository(transaction, secrets);
    const revokeRepository = new ControlPlanePairingRevokeRepository(transaction, secrets);
    const modelRepository = new ControlPlaneModelRepository(transaction, secrets);
    const chatRepository = new ControlPlaneChatRepository(transaction, secrets);
    const gitRepository = new ControlPlaneGitRepository(transaction, secrets);
    for (const node of plan.nodes) await nodeRepository.put(node);
    for (const revoke of plan.pairingRevocations) await revokeRepository.put(revoke);
    for (const model of plan.models) await modelRepository.put(model);
    for (const bridge of plan.chatBridges) await chatRepository.putBridge(bridge);
    for (const session of plan.chatSessions) await chatRepository.putSession(session);
    for (const credential of plan.gitCredentials) {
      const { secretCiphertext: _legacyCiphertext, secret, ...metadata } = credential;
      await gitRepository.putCredential({ ...metadata, secretSet: true, secret });
    }
    for (const assignment of plan.gitAssignments) await transaction.gitAssignments.put(assignment);
    for (const intent of plan.gitProvisioningIntents) await transaction.gitProvisioningIntents.put(intent);
    for (const audit of plan.gitAudit) await transaction.gitAudit.append(audit);
    await transaction.putMigration({
      id: APPLICATION_MIGRATION_ID,
      checksum: APPLICATION_MIGRATION_CHECKSUM,
      appliedAt,
      details: {
        sourceVersion: "v0.0.28",
        sourceDigest: plan.sourceDigest,
        warningCount: plan.warnings.length,
        nodes: plan.nodes.length,
        pairingRevocations: plan.pairingRevocations.length,
        models: plan.models.length,
        chatBridges: plan.chatBridges.length,
        chatSessions: plan.chatSessions.length,
        gitCredentials: plan.gitCredentials.length,
        gitAssignments: plan.gitAssignments.length,
        gitProvisioningIntents: plan.gitProvisioningIntents.length,
        gitAudit: plan.gitAudit.length,
      },
    });
  });
  if (options.archive !== false) archiveLegacyP0Sources(paths, options);
  return { imported: true, plan };
}

function legacySourcesPresent(paths: ControlPlaneStorePaths) {
  return [paths.nodesDir, paths.pendingPairingRevokesDir, paths.modelsDir, paths.chatBridgesDir, paths.chatSessionsDir, path.dirname(paths.gitCredentialsDir)]
    .some((source) => fs.existsSync(source));
}

function protectArchiveTree(target: string) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw migrationError("CONTROL_PLANE_P0_ARCHIVE_SOURCE_INVALID", "Legacy P0 archive contains an unsupported file type.", {
      entry: path.basename(target),
    });
  }
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) protectArchiveTree(path.join(target, entry));
    return;
  }
  fs.chmodSync(target, 0o600);
}

function archiveLegacyP0Sources(paths: ControlPlaneStorePaths, options: { now?: () => Date; onWarning?: (warning: Record<string, unknown>) => void }) {
  const sources = [paths.nodesDir, paths.pendingPairingRevokesDir, paths.modelsDir, paths.chatBridgesDir, paths.chatSessionsDir, path.dirname(paths.gitCredentialsDir)]
    .filter((source) => fs.existsSync(source));
  if (!sources.length) return;
  const stamp = (options.now?.() || new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = path.join(paths.dataDir, "retired-persistence", `v0.0.28-control-plane-p0-${stamp}`);
  const staging = `${destination}.staging`;
  const moved: Array<{ source: string; staged: string }> = [];
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(destination), 0o700);
    fs.mkdirSync(staging, { mode: 0o700 });
    for (const source of sources) {
      const staged = path.join(staging, path.basename(source));
      fs.renameSync(source, staged);
      moved.push({ source, staged });
    }
    protectArchiveTree(staging);
    fs.renameSync(staging, destination);
  } catch (error) {
    for (const entry of moved.reverse()) {
      try { fs.renameSync(entry.staged, entry.source); } catch { /* A later maintenance pass will report the remaining staging directory. */ }
    }
    try { fs.rmdirSync(staging); } catch { /* Preserve non-empty staging for operator recovery. */ }
    options.onWarning?.({
      code: "CONTROL_PLANE_P0_ARCHIVE_FAILED",
      sources: sources.map((source) => path.relative(paths.dataDir, source)),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
