import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  NodeLocalFolderSchema,
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  NodeRuntimeSchema,
  modelConfigHash,
  safeParseStoredControlledInstance,
  sanitizeStoredNodeLocalFolder,
  type ControlledInstance,
  type NodeModelAssignment,
} from "@task-handoff/protocol/control-plane";
import {
  GitWorkspaceProvisioningInputSchema,
  InstanceGitCredentialAssignmentSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  sanitizeGitWorkspaceProvisioningInput,
} from "@task-handoff/protocol/managed-git-credentials";
import type { NodeAgentStorePaths } from "./paths.ts";
import { normalizeNodeAgentIdentity } from "../identity/normalize.ts";
import { AccessRepository } from "./access-repository.ts";
import { createTopologyRepositories } from "./topology-repository.ts";
import { createModelRepositories } from "./model-repository.ts";
import { GitPersistenceRepository, type GitAuthorizationRecord, type GitProvisioningRecord } from "./git-repository.ts";

// Compatibility for v0.0.28: this immutable manifest owns the one-time P0 JSON import and archive contract.
const LEGACY_P0_MIGRATION_ID = "1000_import_v0_0_28_p0";
const LEGACY_P0_MIGRATION_MANIFEST = {
  sourceTag: "v0.0.28",
  plannerVersion: 3,
  domains: ["identity", "folders", "runtimes", "instances", "models", "assignments", "model-environments", "git"],
  transaction: "begin-immediate",
} as const;
const LEGACY_P0_MIGRATION_CHECKSUM = crypto.createHash("sha256").update(JSON.stringify(LEGACY_P0_MIGRATION_MANIFEST)).digest("hex");

type LegacyFile = { filePath: string; value: unknown; digest: string };

const LEGACY_FIELDS = {
  folder: ["id", "nodeId", "name", "path", "defaultImageSelection", "labels", "createdAt", "updatedAt"],
  runtime: ["id", "nodeId", "name", "type", "status", "accessStrategy", "capabilities", "labels", "createdAt", "updatedAt"],
  model: ["id", "name", "endpoint", "key", "model", "modelNames", "protocols", "app", "enabled", "order", "labels", "createdAt", "updatedAt"],
  assignment: ["instanceId", "modelEntityIds", "codexModelHash", "claudeModelHash", "opencodeModelHash", "updatedAt"],
  gitPayload: ["id", "payload", "createdAt", "updatedAt"],
  gitAuthorization: ["id", "instanceId", "generation", "credentialIds", "createdAt", "updatedAt"],
  gitAssignment: ["id", "instanceId", "credentialId", "credentialRevision", "assignmentRevision", "status", "authorizedAt", "createdAt", "updatedAt"],
  gitProvisioning: ["id", "status", "operationId", "input", "createdAt", "updatedAt", "expiresAt"],
} as const;

export function migrateLegacyP0State(
  client: DatabaseSync,
  paths: NodeAgentStorePaths,
  options: { rename?: (source: string, target: string) => void } = {},
) {
  const applied = client.prepare("SELECT checksum FROM na_migration_ledger WHERE id = ?").get(LEGACY_P0_MIGRATION_ID) as { checksum: string } | undefined;
  if (applied) {
    if (applied.checksum !== LEGACY_P0_MIGRATION_CHECKSUM) throw migrationError("ledger", "Legacy P0 migration checksum mismatch.");
    archiveLegacyInputs(paths, options.rename);
    return;
  }

  const warnings: Array<{ source: string; field: string }> = [];
  const inputs = legacyInputs(paths, warnings);
  const hasDomainData = inputs.allFiles.length > 0;
  const identityFile = readOptionalJson(paths.identityPath);
  if (hasDomainData && !identityFile) throw migrationError(paths.identityPath, "Legacy P0 data requires a node identity.");

  try {
    const identity = identityFile
      ? normalizeNodeAgentIdentity(identityFile.value, (_message, details) => warnings.push({ source: paths.identityPath, field: String(details.field || details.fields || "legacy") }))
      : undefined;
    const folders = inputs.folders.map((file) => {
      warnUnknownFields(file, LEGACY_FIELDS.folder, warnings);
      return parse(file, NodeLocalFolderSchema, sanitizeStoredNodeLocalFolder(file.value));
    });
    const runtimes = inputs.runtimes.map((file) => {
      warnUnknownFields(file, LEGACY_FIELDS.runtime, warnings);
      return parse(file, NodeRuntimeSchema.strip(), file.value);
    });
    const privateCredentials = new Map(withoutIsolatedInstanceOwners(inputs.privateConfigs, inputs.isolatedInstanceIds, warnings).map((file) => {
      const source = object(file.value);
      return [path.basename(file.filePath, ".json"), stringValue(source.instanceCredential ?? source.registrationToken)];
    }));
    const instances = inputs.instances.map((file) => {
      const parsed = safeParseStoredControlledInstance(file.value, (warning) => warnings.push({ source: file.filePath, field: warning.field }));
      if (!parsed.success) throw validationError(file, parsed.error);
      return { ...parsed.data, registrationToken: parsed.data.registrationToken || privateCredentials.get(parsed.data.id) } as ControlledInstance;
    });
    const models = inputs.models.flatMap((file) => {
      const source = object(file.value);
      warnUnknownFields(file, LEGACY_FIELDS.model, warnings);
      const parsed = parse(file, NodeModelConfigSchema, pick(source, [
        "id", "name", "endpoint", "key", "model", "modelNames", "protocols", "app", "enabled", "order", "labels", "createdAt", "updatedAt",
      ]));
      if (path.basename(file.filePath, ".json") !== parsed.id || modelConfigHash(parsed) !== parsed.id) {
        warnings.push({ source: file.filePath, field: "identity-or-content-hash" });
        return [];
      }
      return [NodeModelConfigSchema.parse({
        ...parsed,
        modelNames: parsed.modelNames.length ? parsed.modelNames : [{ name: parsed.model, order: 0 }],
        protocols: parsed.protocols.length ? parsed.protocols : [legacyModelProtocol(parsed.app)],
      })];
    });
    const assignments = withoutIsolatedInstanceOwners(inputs.assignments, inputs.isolatedInstanceIds, warnings).map((file) => {
      const source = object(file.value);
      warnUnknownFields(file, LEGACY_FIELDS.assignment, warnings);
      return parse(file, NodeModelAssignmentSchema, pick(source, [
        "instanceId", "modelEntityIds", "codexModelHash", "claudeModelHash", "opencodeModelHash", "updatedAt",
      ]));
    });
    migrateLegacyModelEnvironments(
      withoutIsolatedInstanceOwners(inputs.modelEnvironments, inputs.isolatedInstanceIds, warnings),
      instances,
      models,
      assignments,
    );
    const payloads = inputs.gitPayloads.map((file) => {
      const source = object(file.value);
      warnUnknownFields(file, LEGACY_FIELDS.gitPayload, warnings);
      return {
        id: stringValue(source.id),
        payload: parse(file, NodeGitCredentialPayloadSchema, source.payload),
        createdAt: stringValue(source.createdAt),
        updatedAt: stringValue(source.updatedAt),
      };
    });
    const currentAuthorizations = withoutIsolatedInstanceOwners(inputs.gitAuthorizations, inputs.isolatedInstanceIds, warnings).map((file) => {
      const source = object(file.value);
      warnUnknownFields(file, LEGACY_FIELDS.gitAuthorization, warnings);
      const value = parse(file, NodeGitCredentialAuthorizationSetSchema, pick(source, ["instanceId", "generation", "credentialIds", "updatedAt"]));
      return { ...value, id: value.instanceId, createdAt: stringValue(source.createdAt) } satisfies GitAuthorizationRecord;
    });
    const legacyAssignments = withoutIsolatedInstanceOwners(inputs.gitAssignments, inputs.isolatedInstanceIds, warnings).map((file) => {
      const source = object(file.value);
      warnUnknownFields(file, LEGACY_FIELDS.gitAssignment, warnings);
      return parse(file, InstanceGitCredentialAssignmentSchema, pick(source, [
        "instanceId", "credentialId", "credentialRevision", "assignmentRevision", "status", "authorizedAt", "updatedAt",
      ]));
    });
    const authorizations = collapseLegacyAuthorizations(currentAuthorizations, legacyAssignments);
    const provisioning = withoutIsolatedInstanceOwners(inputs.gitProvisioning, inputs.isolatedInstanceIds, warnings).map((file) => {
      warnUnknownFields(file, LEGACY_FIELDS.gitProvisioning, warnings);
      return parseProvisioning(file);
    });
    validateRelationships({
      identity, folders, runtimes, instances, privateConfigInstanceIds: [...privateCredentials.keys()],
      models, assignments, payloads, authorizations, provisioning,
    });

    client.exec("BEGIN IMMEDIATE");
    try {
      const access = new AccessRepository(client);
      const topology = createTopologyRepositories(client);
      const model = createModelRepositories(client);
      const git = new GitPersistenceRepository(client);
      if (identity) access.writeIdentity(identity);
      for (const folder of folders) topology.localFolders.put(folder);
      for (const runtime of runtimes) topology.runtimes.put(runtime);
      for (const instance of instances) topology.instances.put(instance);
      for (const item of models) model.models.put(item);
      for (const assignment of assignments) model.assignments.put(assignment);
      for (const payload of payloads) git.putPayload(payload);
      for (const authorization of authorizations) git.putAuthorization(authorization);
      for (const record of provisioning) git.putProvisioning(record);

      const details = {
        sourceTag: "v0.0.28",
        counts: {
          identities: identity ? 1 : 0, folders: folders.length, runtimes: runtimes.length,
          instances: instances.length, models: models.length, assignments: assignments.length,
          pairings: identity?.controlPlanePairings?.length || 0, connections: identity?.controlPlaneConnections?.length || 0,
          gitPayloads: payloads.length, gitAuthorizations: authorizations.length, gitProvisioning: provisioning.length,
        },
        inputDigest: inputDigest([...(identityFile ? [identityFile] : []), ...inputs.allFiles]),
        warningCount: warnings.length,
      };
      client.prepare("INSERT INTO na_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)")
        .run(LEGACY_P0_MIGRATION_ID, LEGACY_P0_MIGRATION_CHECKSUM, new Date().toISOString(), JSON.stringify(details));
      client.exec("COMMIT");
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "NODE_AGENT_LEGACY_MIGRATION_FAILED") throw error;
    throw migrationError("p0", "Legacy P0 data failed validation.", error);
  }

  archiveLegacyInputs(paths, options.rename);
  for (const warning of warnings) console.warn(JSON.stringify({ message: "legacy node agent field was ignored", ...warning }));
}

function legacyInputs(paths: NodeAgentStorePaths, warnings: Array<{ source: string; field: string }>) {
  const allFiles: LegacyFile[] = [];
  const isolatedInstanceIds = new Set<string>();
  const read = (directory: string, onIsolated?: (filePath: string) => void) =>
    readJsonDirectory(directory, warnings, allFiles, onIsolated);
  const inputs = {
    folders: read(paths.localFoldersDir),
    runtimes: read(paths.nodeRuntimesDir),
    instances: read(paths.controlledInstancesDir, (filePath) => isolatedInstanceIds.add(path.basename(filePath, ".json"))),
    privateConfigs: read(paths.instancePrivateConfigsDir),
    models: read(paths.nodeModelsDir),
    assignments: read(paths.modelAssignmentsDir),
    modelEnvironments: read(paths.modelEnvironmentsDir),
    gitPayloads: read(paths.gitCredentialPayloadsDir),
    gitAssignments: read(paths.gitCredentialAssignmentsDir),
    gitAuthorizations: read(paths.gitCredentialAuthorizationSetsDir),
    gitProvisioning: read(paths.gitWorkspaceProvisioningIntentsDir),
  };
  return { ...inputs, allFiles, isolatedInstanceIds };
}

function readJsonDirectory(
  directory: string,
  warnings: Array<{ source: string; field: string }>,
  allFiles: LegacyFile[],
  onIsolated?: (filePath: string) => void,
): LegacyFile[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
    const filePath = path.join(directory, name);
    let contents: string;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw migrationError(filePath, "Legacy JSON could not be accessed.", error);
    }
    const digest = crypto.createHash("sha256").update(contents).digest("hex");
    const input = { filePath, value: undefined, digest } satisfies LegacyFile;
    allFiles.push(input);
    try {
      input.value = JSON.parse(contents);
      return [input];
    } catch {
      // Compatibility for v0.0.28: JsonCollection isolated unreadable records instead of failing startup.
      warnings.push({ source: filePath, field: "unreadable-record" });
      onIsolated?.(filePath);
      return [];
    }
  });
}

function withoutIsolatedInstanceOwners(
  files: LegacyFile[],
  isolatedInstanceIds: Set<string>,
  warnings: Array<{ source: string; field: string }>,
) {
  return files.filter((file) => {
    const source = object(file.value);
    const instanceId = typeof source.instanceId === "string"
      ? source.instanceId
      : path.basename(file.filePath, ".json");
    if (!isolatedInstanceIds.has(instanceId)) return true;
    warnings.push({ source: file.filePath, field: "isolated-instance-owner" });
    return false;
  });
}

function readOptionalJson(filePath: string) {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw migrationError(filePath, "Legacy JSON could not be accessed.", error);
  }
  if (!stat.isFile()) throw migrationError(filePath, "Legacy JSON must be a regular file.");
  return readJson(filePath);
}

function readJson(filePath: string): LegacyFile {
  try {
    const contents = fs.readFileSync(filePath, "utf8");
    return { filePath, value: JSON.parse(contents), digest: crypto.createHash("sha256").update(contents).digest("hex") };
  } catch (error) {
    throw migrationError(filePath, "Legacy JSON could not be read.", error);
  }
}

function parse<T>(file: LegacyFile, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(file, parsed.error);
  return parsed.data;
}

function validationError(file: LegacyFile, error: z.ZodError) {
  return migrationError(file.filePath, "Legacy record is missing a required field or has an invalid type.", undefined, {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

function parseProvisioning(file: LegacyFile): GitProvisioningRecord {
  const source = object(file.value);
  const common = {
    id: stringValue(source.id), createdAt: stringValue(source.createdAt), updatedAt: stringValue(source.updatedAt), expiresAt: stringValue(source.expiresAt),
  };
  if (source.status === "consumed") return { ...common, status: "consumed", operationId: stringValue(source.operationId) };
  const sanitized = sanitizeGitWorkspaceProvisioningInput(source.input);
  if (!sanitized.success) throw validationError(file, sanitized.error);
  const input = GitWorkspaceProvisioningInputSchema.parse(sanitized.data);
  return { ...common, id: input.instanceId, status: "pending", input };
}

function collapseLegacyAuthorizations(current: GitAuthorizationRecord[], legacy: Array<z.infer<typeof InstanceGitCredentialAssignmentSchema>>) {
  const result = new Map(current.map((record) => [record.instanceId, record]));
  for (const instanceId of new Set(legacy.map((record) => record.instanceId))) {
    if (result.has(instanceId)) continue;
    const records = legacy.filter((record) => record.instanceId === instanceId).sort((left, right) => left.credentialId.localeCompare(right.credentialId));
    const timestamp = records.map((record) => record.updatedAt).sort().at(-1)!;
    result.set(instanceId, {
      id: instanceId, instanceId, generation: Math.max(0, ...records.map((record) => record.assignmentRevision)),
      credentialIds: records.filter((record) => record.status !== "revoking" && record.status !== "revoked").map((record) => record.credentialId),
      createdAt: timestamp, updatedAt: timestamp,
    });
  }
  return [...result.values()].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

function validateRelationships(input: {
  identity?: ReturnType<typeof normalizeNodeAgentIdentity>;
  folders: Array<z.infer<typeof NodeLocalFolderSchema>>;
  runtimes: Array<z.infer<typeof NodeRuntimeSchema>>;
  instances: ControlledInstance[];
  privateConfigInstanceIds: string[];
  models: Array<z.infer<typeof NodeModelConfigSchema>>;
  assignments: NodeModelAssignment[];
  payloads: Array<{ id: string; payload: z.infer<typeof NodeGitCredentialPayloadSchema> }>;
  authorizations: GitAuthorizationRecord[];
  provisioning: GitProvisioningRecord[];
}) {
  const identityNodeId = input.identity?.nodeId;
  const folderIds = uniqueIds("local folder", input.folders.map((record) => record.id));
  const runtimeIds = uniqueIds("runtime", input.runtimes.map((record) => record.id));
  const instanceIds = uniqueIds("instance", input.instances.map((record) => record.id));
  const modelIds = uniqueIds("model", input.models.map((record) => record.id));
  const payloadIds = uniqueIds("Git credential payload", input.payloads.map((record) => record.id));
  uniqueIds("model assignment", input.assignments.map((record) => record.instanceId));
  uniqueIds("Git authorization", input.authorizations.map((record) => record.instanceId));
  uniqueIds("Git provisioning", input.provisioning.map((record) => record.id));

  for (const record of [...input.folders, ...input.runtimes]) {
    if (!identityNodeId || record.nodeId !== identityNodeId) {
      throw relationError("node-identity", record.id, record.nodeId, "Legacy topology record references a different or missing node identity.");
    }
  }
  for (const instance of input.instances) {
    if (!identityNodeId || instance.nodeId !== identityNodeId) {
      throw relationError("node-identity", instance.id, instance.nodeId, "Legacy instance references a different or missing node identity.");
    }
    if (!runtimeIds.has(instance.runtimeId)) throw relationError("runtime", instance.id, instance.runtimeId, "Legacy instance references a missing runtime.");
    if (instance.source.type === "local-folder" && instance.source.localFolderId && !folderIds.has(instance.source.localFolderId)) {
      throw relationError("local-folder", instance.id, instance.source.localFolderId, "Legacy instance references a missing local folder.");
    }
  }
  for (const instanceId of input.privateConfigInstanceIds) {
    if (!instanceIds.has(instanceId)) throw relationError("instance", instanceId, instanceId, "Legacy private config references a missing instance.");
  }
  for (const assignment of input.assignments) {
    if (!instanceIds.has(assignment.instanceId)) throw relationError("instance", assignment.instanceId, assignment.instanceId, "Legacy model assignment references a missing instance.");
    for (const modelId of new Set([
      ...assignment.modelEntityIds, assignment.codexModelHash, assignment.claudeModelHash, assignment.opencodeModelHash,
    ].filter((id): id is string => Boolean(id)))) {
      if (!modelIds.has(modelId)) throw relationError("model", assignment.instanceId, modelId, "Legacy model assignment references a missing model.");
    }
  }
  for (const payload of input.payloads) {
    if (payload.id !== payload.payload.credential.id) {
      throw relationError("Git credential payload", payload.id, payload.payload.credential.id, "Legacy Git credential wrapper and payload ids do not match.");
    }
  }
  for (const authorization of input.authorizations) {
    if (!instanceIds.has(authorization.instanceId)) throw relationError("instance", authorization.instanceId, authorization.instanceId, "Legacy Git authorization references a missing instance.");
    for (const credentialId of authorization.credentialIds) {
      if (!payloadIds.has(credentialId)) throw relationError("Git credential payload", authorization.instanceId, credentialId, "Legacy Git authorization references a missing credential payload.");
    }
  }
  for (const provisioning of input.provisioning) {
    if (!instanceIds.has(provisioning.id)) throw relationError("instance", provisioning.id, provisioning.id, "Legacy Git provisioning references a missing instance.");
  }
  if (input.identity) {
    const pairingIds = uniqueIds("Control Plane pairing", input.identity.controlPlanePairings.map((record) => record.keyId));
    uniqueIds("Control Plane connection", input.identity.controlPlaneConnections.map((record) => record.id));
    const urls = new Set<string>();
    for (const connection of input.identity.controlPlaneConnections) {
      if (!pairingIds.has(connection.pairingKeyId)) throw relationError("Control Plane pairing", connection.id, connection.pairingKeyId, "Legacy connection references a missing pairing.");
      const normalizedUrl = new URL(connection.url).toString().replace(/\/$/, "");
      if (urls.has(normalizedUrl)) throw relationError("Control Plane URL", connection.id, normalizedUrl, "Legacy connections contain a duplicate normalized URL.");
      urls.add(normalizedUrl);
    }
  }
}

function uniqueIds(label: string, ids: string[]) {
  const result = new Set<string>();
  for (const id of ids) {
    if (result.has(id)) throw migrationError(label, `Legacy ${label} id is duplicated.`, undefined, { recordId: id });
    result.add(id);
  }
  return result;
}

function relationError(relation: string, recordId: string, referencedId: string, message: string) {
  return migrationError(relation, message, undefined, { relation, recordId, referencedId });
}

function legacyModelProtocol(app: "codex" | "claude" | "opencode") {
  return app === "claude" ? "anthropic-messages" as const
    : app === "opencode" ? "openai-chat-completions" as const
      : "openai-responses" as const;
}

function archiveLegacyInputs(paths: NodeAgentStorePaths, rename = fs.renameSync) {
  const sources = [
    paths.identityPath, paths.localFoldersDir, paths.nodeRuntimesDir, paths.controlledInstancesDir,
    paths.nodeModelsDir, paths.modelAssignmentsDir, paths.gitCredentialPayloadsDir,
    paths.modelEnvironmentsDir,
    paths.gitCredentialAssignmentsDir, paths.gitCredentialAuthorizationSetsDir, paths.gitWorkspaceProvisioningIntentsDir,
  ];
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    const baseTarget = `${source}.migrated-v0.0.28`;
    let target = baseTarget;
    for (let suffix = 1; fs.existsSync(target); suffix += 1) target = `${baseTarget}.${suffix}`;
    try { rename(source, target); }
    catch (error) {
      console.warn(JSON.stringify({ message: "legacy node agent persistence archive failed", source, target, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

// Compatibility for v0.0.28: model environment sidecars are folded into current model and assignment records.
function migrateLegacyModelEnvironments(
  files: LegacyFile[],
  instances: ControlledInstance[],
  models: z.infer<typeof NodeModelConfigSchema>[],
  assignments: NodeModelAssignment[],
) {
  const instanceIds = new Set(instances.map((instance) => instance.id));
  const assignmentsByInstance = new Map(assignments.map((assignment) => [assignment.instanceId, assignment]));
  const modelsById = new Map(models.map((model) => [model.id, model]));
  let nextOrder = models.reduce((maximum, model) => Math.max(maximum, model.order), 0) + 100;
  for (const file of files) {
    const instanceId = path.basename(file.filePath, ".json");
    if (!instanceIds.has(instanceId)) throw migrationError(file.filePath, `Legacy model environment references missing instance ${instanceId}.`);
    if (assignmentsByInstance.has(instanceId)) continue;
    const parsed = z.record(z.string(), z.string()).safeParse(file.value);
    if (!parsed.success) throw validationError(file, parsed.error);
    const environment = parsed.data;
    const allowed = new Set([
      "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_MODEL", "TASK_HANDOFF_CODEX_BASE_URL", "TASK_HANDOFF_CODEX_MODEL",
      "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_MODEL", "TASK_HANDOFF_CLAUDE_MODEL",
    ]);
    if (Object.keys(environment).some((key) => !allowed.has(key))) throw migrationError(file.filePath, "Legacy model environment contains an unknown field.");
    const entityIds: string[] = [];
    const hashes: Partial<Pick<NodeModelAssignment, "codexModelHash" | "claudeModelHash">> = {};
    for (const app of ["codex", "claude"] as const) {
      const key = environment[app === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
      const endpoint = app === "codex"
        ? environment.TASK_HANDOFF_CODEX_BASE_URL || environment.OPENAI_BASE_URL
        : environment.ANTHROPIC_BASE_URL;
      const modelName = app === "codex"
        ? environment.TASK_HANDOFF_CODEX_MODEL || environment.CODEX_MODEL
        : environment.TASK_HANDOFF_CLAUDE_MODEL || environment.CLAUDE_MODEL;
      if (!key && !endpoint && !modelName) continue;
      if (!key || !endpoint || !modelName) throw migrationError(file.filePath, `Legacy ${app} model environment is incomplete.`);
      const id = modelConfigHash({ app, endpoint, key, model: modelName });
      if (!modelsById.has(id)) {
        const timestamp = instances.find((instance) => instance.id === instanceId)!.updatedAt;
        const model = NodeModelConfigSchema.parse({
          id, name: `Migrated ${app === "codex" ? "Codex" : "Claude"} model`, endpoint, key, model: modelName,
          app, enabled: true, order: nextOrder, labels: { migratedFrom: "instance-model-environment" },
          createdAt: timestamp, updatedAt: timestamp,
        });
        nextOrder += 100;
        models.push(model);
        modelsById.set(id, model);
      }
      entityIds.push(id);
      if (app === "codex") hashes.codexModelHash = id;
      else hashes.claudeModelHash = id;
    }
    if (!entityIds.length) throw migrationError(file.filePath, "Legacy model environment has no complete model configuration.");
    const assignment = NodeModelAssignmentSchema.parse({
      instanceId, modelEntityIds: entityIds, ...hashes,
      updatedAt: instances.find((instance) => instance.id === instanceId)!.updatedAt,
    });
    assignments.push(assignment);
    assignmentsByInstance.set(instanceId, assignment);
  }
}

function inputDigest(files: LegacyFile[]) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((left, right) => left.filePath.localeCompare(right.filePath))) {
    hash.update(path.basename(file.filePath));
    hash.update(file.digest);
  }
  return hash.digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw migrationError("record", "Legacy record must be an object.");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  if (typeof value !== "string" || !value) throw migrationError("record", "Legacy record is missing a required string.");
  return value;
}

function pick(source: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(fields.flatMap((field) => Object.prototype.hasOwnProperty.call(source, field) ? [[field, source[field]]] : []));
}

function warnUnknownFields(file: LegacyFile, allowed: readonly string[], warnings: Array<{ source: string; field: string }>) {
  const value = object(file.value);
  const known = new Set(allowed);
  for (const field of Object.keys(value).filter((candidate) => !known.has(candidate)).sort()) {
    warnings.push({ source: file.filePath, field });
  }
}

function migrationError(source: string, message: string, cause?: unknown, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "NODE_AGENT_LEGACY_MIGRATION_FAILED", statusCode: 500, details: { source, ...details },
  });
}
