import crypto from "node:crypto";
import { z } from "zod";
import {
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENTS,
  AiSessionMessageAttachmentSchema,
  AiSessionsSnapshotSchema,
} from "./ai-sessions.ts";
import { TriggerConfigSchema, TriggerDeploymentSchema, TriggerRunSchema, TriggerRuntimeStateSchema } from "./triggers.ts";

export const CONTROL_PLANE_PROTOCOL_VERSION = "2026-07-23";
// The local value follows the date-only convention. Parsing remains permissive
// so persisted records written before that convention do not disappear.
export const ProtocolVersionSchema = z.string();

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();
const LabelsSchema = z.record(z.string(), z.string()).default({});
const StringRecordSchema = z.record(z.string(), z.string()).default({});

const DockerTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DockerDigestPattern = /^sha256:([a-fA-F0-9]{64})$/;
const DockerRegistryPattern = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const DockerRepositoryComponentPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

export function normalizeDockerImageReference(input: string) {
  const value = input.trim();
  if (!value || value.length > 512 || value.includes("://") || /\s/.test(value)) {
    throw new Error("Docker image reference must not contain a URL scheme or whitespace.");
  }
  const at = value.indexOf("@");
  if (at !== -1 && at !== value.lastIndexOf("@")) throw new Error("Docker image reference contains more than one digest separator.");
  const digestInput = at === -1 ? undefined : value.slice(at + 1);
  const base = at === -1 ? value : value.slice(0, at);
  const digestMatch = digestInput ? DockerDigestPattern.exec(digestInput) : undefined;
  if (digestInput && !digestMatch) throw new Error("Docker image digest must use sha256 followed by 64 hexadecimal characters.");

  const lastSlash = base.lastIndexOf("/");
  const lastColon = base.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const tag = hasTag ? base.slice(lastColon + 1) : undefined;
  const name = hasTag ? base.slice(0, lastColon) : base;
  if (tag && !DockerTagPattern.test(tag)) throw new Error("Docker image tag is invalid.");
  if (!tag && !digestMatch) throw new Error("Docker image reference must include an explicit tag or sha256 digest.");

  const parts = name.split("/");
  if (!parts.length || parts.some((part) => !part)) throw new Error("Docker image repository path is invalid.");
  const hasRegistry = parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost");
  const repositoryParts = hasRegistry ? parts.slice(1) : parts;
  if (hasRegistry && !DockerRegistryPattern.test(parts[0].toLowerCase())) throw new Error("Docker image registry host or port is invalid.");
  if (!repositoryParts.length || repositoryParts.some((part) => !DockerRepositoryComponentPattern.test(part))) {
    throw new Error("Docker image repository names must be lowercase and use valid separators.");
  }

  const normalizedName = parts.map((part, index) => hasRegistry && index === 0 ? part.toLowerCase() : part).join("/");
  const normalizedDigest = digestMatch ? `sha256:${digestMatch[1].toLowerCase()}` : undefined;
  return `${normalizedName}${tag ? `:${tag}` : ""}${normalizedDigest ? `@${normalizedDigest}` : ""}`;
}

export const DockerImageReferenceSchema = z.string().trim().min(1).max(512).transform((value, context) => {
  try {
    return normalizeDockerImageReference(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export const DockerImageDigestSchema = z.string().trim().transform((value, context) => {
  const match = DockerDigestPattern.exec(value);
  if (!match) {
    context.addIssue({ code: "custom", message: "Docker image digest must use sha256 followed by 64 hexadecimal characters." });
    return z.NEVER;
  }
  return `sha256:${match[1].toLowerCase()}`;
});

// Omitted uses the enabled global default, null disables managed model binding,
// and a hash pins the instance to that model.
export const ModelSelectionSchema = z
  .object({
    codexModelHash: IdSchema.nullable().optional(),
    claudeModelHash: IdSchema.nullable().optional(),
  })
  .strict()
  .default({});

export const InstanceAppInventoryItemSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["tty", "gui", "web"]),
    source: z.enum(["builtin", "custom"]),
    availability: z.enum(["available", "missing-dependency"]),
    capabilities: z
      .object({
        automation: z.enum(["cdp"]).optional(),
        supportsCwdSelection: z.boolean().default(false),
      })
      .strict()
      .default({ supportsCwdSelection: false }),
    diagnosticCode: z.enum(["APP_EXECUTABLE_NOT_FOUND"]).optional(),
  })
  .strict();

export const InstanceAppInventoryIssueSchema = z
  .object({
    code: z.enum(["APP_CATALOG_INVALID"]),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export const InstanceAppInventorySchema = z
  .object({
    items: z.array(InstanceAppInventoryItemSchema).max(256),
    observedAt: TimestampSchema,
    issues: z.array(InstanceAppInventoryIssueSchema).max(32).default([]),
  })
  .strict();

export const FinalComputerPlatformSchema = z.enum(["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos", "unknown"]);
export const FinalComputerArchSchema = z.enum(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "unknown"]);
export const AppInstallerSchema = z.enum(["apt", "dnf", "brew", "npm"]);
export const AppInstallPrivilegeSchema = z.enum(["user", "passwordless-sudo", "root"]);
export const FinalComputerCapabilitiesSchema = z.object({
  platform: FinalComputerPlatformSchema,
  arch: FinalComputerArchSchema,
  installers: z.array(AppInstallerSchema).max(8),
  privilege: AppInstallPrivilegeSchema,
  installerAccess: z.object({
    npmGlobalWritable: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const ManagedAppStateSchema = z.enum(["installed", "not-installed", "broken", "unsupported"]);
export const ManagedAppManagementSourceSchema = z.enum(["recipe", "bundled", "external", "none"]);
export const ManagedAppActionReasonSchema = z.object({
  code: z.enum(["BUNDLED", "EXTERNALLY_MANAGED", "ALREADY_INSTALLED", "NOT_INSTALLED", "UNSUPPORTED_PLATFORM", "INSTALLER_UNAVAILABLE", "INSTALLER_NOT_WRITABLE", "INSUFFICIENT_PRIVILEGE", "OPERATION_IN_PROGRESS"]),
  message: z.string().trim().min(1).max(500),
}).strict();
export const ManagedAppProjectionSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["tty", "gui", "web"]),
  description: z.string().trim().max(500).optional(),
  state: ManagedAppStateSchema,
  managementSource: ManagedAppManagementSourceSchema,
  version: z.string().trim().max(120).optional(),
  canInstall: z.boolean(),
  canUninstall: z.boolean(),
  installReason: ManagedAppActionReasonSchema.optional(),
  uninstallReason: ManagedAppActionReasonSchema.optional(),
  activeJobId: IdSchema.optional(),
}).strict();

export const AppManagementOperationSchema = z.enum(["install", "uninstall"]);
export const AppManagementJobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);
export const AppManagementProgressSchema = z.object({
  current: z.number().finite().nonnegative().optional(),
  total: z.number().finite().positive().optional(),
  unit: z.string().trim().min(1).max(40).optional(),
}).strict().refine((value) => value.total === undefined || value.current === undefined || value.current <= value.total, {
  message: "Progress current must not exceed total.",
  path: ["current"],
});
export const AppManagementCommandSchema = z.object({
  executable: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(128),
}).strict();
export const AppManagementErrorSchema = z.object({
  code: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  message: z.string().trim().min(1).max(4096),
  retryable: z.boolean(),
  sessionIds: z.array(IdSchema).max(64).optional(),
}).strict();
export const AppManagementJobSchema = z.object({
  id: IdSchema,
  requestId: IdSchema.optional(),
  appId: IdSchema,
  operation: AppManagementOperationSchema,
  state: AppManagementJobStateSchema,
  phase: z.string().trim().min(1).max(120).optional(),
  progress: AppManagementProgressSchema.optional(),
  command: AppManagementCommandSchema.optional(),
  logTail: z.string().max(32768).optional(),
  logTruncated: z.boolean().optional(),
  error: AppManagementErrorSchema.optional(),
  requestedAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();
export const AppManagementSnapshotSchema = z.object({
  streamId: IdSchema,
  sequence: z.number().int().nonnegative(),
  capabilities: FinalComputerCapabilitiesSchema,
  apps: z.array(ManagedAppProjectionSchema).max(256),
  activeJobs: z.array(AppManagementJobSchema).max(256),
  recentJobs: z.array(AppManagementJobSchema).max(256),
  observedAt: TimestampSchema,
}).strict();
export const AppManagementOperationRequestSchema = z.object({
  requestId: IdSchema.optional(),
}).strict();
export const AppManagementJobResponseSchema = z.object({
  job: AppManagementJobSchema,
}).strict();
export const AppManagementEventSchema = z.object({
  type: z.literal("app-management"),
  streamId: IdSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
  job: AppManagementJobSchema.optional(),
  snapshot: AppManagementSnapshotSchema.optional(),
}).strict().refine((value) => value.job !== undefined || value.snapshot !== undefined, {
  message: "An app management event requires a job or snapshot.",
});

export const BuildInfoSchema = z
  .object({
    component: z.enum(["control-plane", "node-agent", "controlled-instance"]),
    packageName: z.string().trim().max(160).optional(),
    packageVersion: z.string().trim().max(80).optional(),
    protocolVersion: ProtocolVersionSchema.optional(),
    buildId: z.string().trim().max(160).optional(),
    builtAt: z.string().trim().max(120).optional(),
    gitCommit: z.string().trim().max(120).optional(),
    imageRef: z.string().trim().max(512).optional(),
    imageDigest: z.string().trim().max(240).optional(),
  })
  .strict();

export const UpdateChannelSchema = z.enum(["stable", "beta", "alpha"]);
export const UpdateTargetSchema = z.discriminatedUnion("component", [
  z.object({ component: z.literal("node-agent") }).strict(),
  z.object({ component: z.literal("controlled-instance"), instanceId: IdSchema }).strict(),
]);
export const UpdateCheckRequestSchema = z.object({
  target: UpdateTargetSchema,
  channel: UpdateChannelSchema.default("stable"),
}).strict();
export const UpdateCheckResultSchema = z.object({
  target: UpdateTargetSchema,
  source: z.enum(["npm", "docker-registry"]),
  channel: UpdateChannelSchema,
  currentVersion: z.string().trim().max(240).optional(),
  availableVersion: z.string().trim().min(1).max(240),
  artifactRef: z.string().trim().min(1).max(512).optional(),
  updateAvailable: z.boolean(),
  supported: z.boolean().default(true),
  reason: z.string().trim().max(2048).optional(),
  checkedAt: TimestampSchema,
}).strict();
export const UpdateJobSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  target: UpdateTargetSchema,
  source: z.enum(["npm", "docker-registry"]),
  channel: UpdateChannelSchema,
  fromVersion: z.string().trim().max(240).optional(),
  toVersion: z.string().trim().min(1).max(240),
  artifactRef: z.string().trim().min(1).max(512).optional(),
  status: z.enum(["queued", "updating", "restarting", "succeeded", "failed"]),
  error: z.string().trim().max(4096).optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export const ApplyUpdateRequestSchema = UpdateCheckRequestSchema;

export const GitRefSchema = z
  .object({
    type: z.enum(["branch", "tag", "commit"]),
    name: z.string().trim().min(1).max(240).optional(),
    commit: z.string().trim().max(80).optional(),
  })
  .strict();

export const GitAuthSchema = z
  .object({
    type: z.enum(["none", "ssh-key", "https-token"]).default("none"),
    secretId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const GitCloneOptionsSchema = z
  .object({
    depth: z.number().int().positive().max(100000).optional(),
    submodules: z.boolean().default(false),
    lfs: z.boolean().default(false),
    subdirectory: z.string().trim().max(240).default(""),
  })
  .strict();

export const GitRepositorySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    url: z.string().trim().min(1).max(2048),
    provider: z.string().trim().max(80).optional(),
    ref: GitRefSchema.default({ type: "branch", name: "main" }),
    auth: GitAuthSchema.default({ type: "none" }),
    clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    defaultImageId: IdSchema.optional(),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NodeLocalFolderSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4096),
    defaultImageId: IdSchema.optional(),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ProjectSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("git-repository"),
      repositoryId: IdSchema.optional(),
      url: z.string().trim().min(1).max(2048),
      provider: z.string().trim().max(80).optional(),
      ref: GitRefSchema.default({ type: "branch", name: "main" }),
      auth: GitAuthSchema.default({ type: "none" }),
      clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    })
    .strict(),
  z
    .object({
      type: z.literal("git-template"),
      url: z.string().trim().min(1).max(2048),
      templateId: z.string().trim().min(1).max(120).optional(),
      ref: GitRefSchema.default({ type: "branch", name: "main" }),
      auth: GitAuthSchema.default({ type: "none" }),
      clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    })
    .strict(),
  z
    .object({
      type: z.literal("local-folder"),
      localFolderId: IdSchema.optional(),
      path: z.string().trim().min(1).max(4096),
      ownerNodeId: IdSchema.optional(),
    })
    .strict(),
]);

export const WorkspacePolicySchema = z
  .object({
    mode: z.enum(["local-bind", "git-clone", "empty-volume", "persistent-volume"]),
    path: z.string().trim().min(1).max(4096).default("/workspace"),
    volumeName: z.string().trim().max(240).optional(),
    readOnly: z.boolean().default(false),
  })
  .strict();

export const ModelAppSchema = z.enum(["codex", "claude"]);

export const ProjectSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    source: ProjectSourceSchema,
    defaultImageId: IdSchema.optional(),
    defaultNodeId: IdSchema.optional(),
    defaultRuntimeId: IdSchema.optional(),
    workspacePolicy: WorkspacePolicySchema,
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ModelConfigSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    endpoint: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(4096),
    model: z.string().trim().min(1).max(240),
    app: ModelAppSchema,
    enabled: z.boolean().default(true),
    order: z.number().int().min(0).max(1_000_000).default(0),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NodeModelConfigSchema = ModelConfigSchema;

export const PublicModelConfigSchema = ModelConfigSchema.omit({ key: true }).extend({
  keyPreview: z.string().trim().min(1).max(160),
  keySet: z.boolean(),
}).strict();

export const NodeModelPublicRecordSchema = PublicModelConfigSchema.extend({
  referenceCount: z.number().int().min(0),
}).strict();

export const NodeModelAssignmentSchema = z.object({
  instanceId: IdSchema,
  codexModelHash: IdSchema.optional(),
  claudeModelHash: IdSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();

export const ModelLocationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("control-plane"),
    name: ModelConfigSchema.shape.name,
    enabled: ModelConfigSchema.shape.enabled,
    order: ModelConfigSchema.shape.order,
  }).strict(),
  z.object({
    type: z.literal("node"),
    nodeId: IdSchema,
    name: ModelConfigSchema.shape.name,
    enabled: ModelConfigSchema.shape.enabled,
    order: ModelConfigSchema.shape.order,
    referenceCount: z.number().int().min(0),
  }).strict(),
]);

export const FederatedModelGroupSchema = z.object({
  id: IdSchema,
  model: PublicModelConfigSchema,
  locations: z.array(ModelLocationSchema).min(1),
  referenceCount: z.number().int().min(0).default(0),
}).strict();

export const ModelRegistryNodeDiagnosticSchema = z.object({
  nodeId: IdSchema,
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
}).strict();

export const FederatedModelRegistrySchema = z.object({
  models: z.array(FederatedModelGroupSchema),
  nodeDiagnostics: z.array(ModelRegistryNodeDiagnosticSchema).default([]),
  updatedAt: TimestampSchema,
}).strict();

export const CreateNodeModelSchema = ModelConfigSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).strict();

export const UpdateNodeModelSchema = CreateNodeModelSchema.partial().strict();

export const DeployNodeModelSchema = ModelConfigSchema;

export const UpdateNodeModelAssignmentSchema = z.object({
  modelSelection: ModelSelectionSchema,
  codexModelHash: IdSchema.optional(),
  claudeModelHash: IdSchema.optional(),
}).strict();

export function modelConfigHash(input: Pick<z.infer<typeof ModelConfigSchema>, "app" | "endpoint" | "key" | "model">) {
  const canonical = {
    app: ModelAppSchema.parse(input.app),
    endpoint: ModelConfigSchema.shape.endpoint.parse(input.endpoint),
    key: ModelConfigSchema.shape.key.parse(input.key),
    model: ModelConfigSchema.shape.model.parse(input.model),
  };
  return `mdl_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export const ImageProfileSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    reference: DockerImageReferenceSchema,
    pullPolicy: z.literal("if-not-present").default("if-not-present"),
    capabilities: z.array(z.string().trim().min(1).max(80)).default([]),
    optionalApps: z.array(z.string().trim().min(1).max(120)).default([]),
    defaultEnv: StringRecordSchema,
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const InstanceImageSnapshotSchema = ImageProfileSchema.omit({ reference: true }).extend({
  requestedReference: DockerImageReferenceSchema,
  resolvedDigest: DockerImageDigestSchema.optional(),
  resolvedReference: DockerImageReferenceSchema.optional(),
}).strict();

export const ImageProvisioningSchema = z.object({
  phase: z.enum(["checking-image", "pulling-image", "resolving-image", "ready", "failed"]),
  requestedReference: DockerImageReferenceSchema,
  generation: z.number().int().nonnegative().default(0),
  error: z.string().trim().max(4096).optional(),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export function sanitizeStoredImageProfile(
  input: unknown,
  onWarning?: (warning: { imageId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const imageId = typeof source.id === "string" ? source.id : undefined;
  const legacyReference = typeof source.image === "string" ? source.image : undefined;
  if (legacyReference !== undefined) onWarning?.({ imageId, field: "image" });
  if (Object.prototype.hasOwnProperty.call(source, "registry")) onWarning?.({ imageId, field: "registry" });
  let reference = typeof source.reference === "string" ? source.reference : legacyReference;
  if (reference) {
    try {
      reference = normalizeDockerImageReference(reference);
    } catch {
      if (!reference.includes("@") && reference.lastIndexOf(":") <= reference.lastIndexOf("/")) {
        try {
          reference = normalizeDockerImageReference(`${reference}:latest`);
          onWarning?.({ imageId, field: "reference:implicit-latest" });
        } catch {
          // Leave invalid historical values for record-level schema isolation.
        }
      }
    }
  }
  return {
    id: source.id,
    name: source.name,
    reference,
    pullPolicy: source.pullPolicy ?? "if-not-present",
    capabilities: source.capabilities,
    optionalApps: source.optionalApps,
    defaultEnv: source.defaultEnv,
    labels: source.labels,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function sanitizeStoredInstanceImageSnapshot(
  input: unknown,
  imageId: unknown,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
  instanceId?: string,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const sanitizedProfile = sanitizeStoredImageProfile(source) as Record<string, unknown>;
  const { reference: profileReference, ...profile } = sanitizedProfile;
  const requestedReference = source.requestedReference ?? profileReference;
  if (source.image !== undefined || source.reference !== undefined) onWarning?.({ instanceId, field: "imageSnapshot.reference" });
  return {
    ...profile,
    id: source.id ?? imageId,
    requestedReference,
    resolvedDigest: source.resolvedDigest,
    resolvedReference: source.resolvedReference,
  };
}

export const NodeSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    connectionMode: z.enum(["local-ipc", "local-loopback", "direct-http", "reverse-wss"]).default("direct-http"),
    auth: z
      .object({
        mode: z.enum(["local-static-key", "paired-hmac"]).default("local-static-key"),
        keyId: IdSchema.optional(),
        secret: z.string().trim().max(4096).optional(),
        pairedAt: TimestampSchema.optional(),
        pairing: z
          .object({
            status: z.enum(["pending", "paired", "expired"]).default("pending"),
            joinToken: z.string().trim().max(4096).optional(),
            expiresAt: TimestampSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ mode: "local-static-key" }),
    endpoint: z.string().trim().max(2048).optional(),
    controlEndpoint: z.string().trim().max(2048).optional(),
    containerEndpoint: z.string().trim().max(2048).optional(),
    publicWebBase: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "online", "offline", "degraded"]).default("unknown"),
    health: z.enum(["unknown", "ok", "degraded", "failed"]).default("unknown"),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    appInventory: InstanceAppInventorySchema.optional(),
    labels: LabelsSchema,
    lastSeenAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NodeRuntimeSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    name: z.string().trim().min(1).max(160),
    type: z.enum(["docker", "kubernetes", "local"]),
    status: z.enum(["unknown", "online", "offline", "degraded"]).default("unknown"),
    accessStrategy: z.enum(["node-proxy", "direct-port", "kubernetes-ingress", "kubernetes-port-forward"]).default("node-proxy"),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const InstanceResourceMetricsSchema = z.object({
  instanceId: IdSchema,
  runtimeKind: z.literal("docker"),
  state: z.enum(["pending", "available", "stopped", "unavailable"]),
  sampledAt: TimestampSchema,
  cpu: z.object({ usagePercent: z.number().nonnegative() }).strict().optional(),
  memory: z.object({
    usageBytes: z.number().nonnegative(),
    limitBytes: z.number().nonnegative().optional(),
    usagePercent: z.number().nonnegative().optional(),
  }).strict().optional(),
  network: z.object({
    rxBytes: z.number().nonnegative(),
    txBytes: z.number().nonnegative(),
  }).strict().optional(),
  blockIo: z.object({
    readBytes: z.number().nonnegative(),
    writeBytes: z.number().nonnegative(),
  }).strict().optional(),
  pids: z.number().int().nonnegative().optional(),
  error: z.string().trim().max(2048).optional(),
}).strict();

export const InstanceResourceMetricsEventType = {
  Snapshot: "instance.metrics.snapshot",
} as const;

export const NodeAgentHealthSchema = z
  .object({
    ok: z.boolean().optional(),
    role: z.string().optional(),
    nodeId: IdSchema.optional(),
  })
  .passthrough();

export const NodeAgentExternalListenerConfigSchema = z
  .object({
    bindScope: z.enum(["loopback", "all-ipv4"]),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const NodeAgentExternalListenerSchema = NodeAgentExternalListenerConfigSchema.extend({
  host: z.enum(["127.0.0.1", "0.0.0.0"]),
  status: z.enum(["listening", "error"]),
  source: z.enum(["bootstrap", "persisted"]),
  error: z.string().trim().max(2048).optional(),
}).strict();

export const UpdateNodeAgentExternalListenerSchema = NodeAgentExternalListenerConfigSchema;

export const NodeAgentPairingInviteResponseSchema = z
  .object({
    nodeId: IdSchema,
    joinToken: z.string().trim().min(1),
    expiresAt: TimestampSchema,
  })
  .passthrough();

export const NodeAgentRemoteControlPlaneSchema = z
  .object({
    id: IdSchema,
    keyId: IdSchema,
    url: z.string().trim().min(1).max(2048).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    pairedAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
    active: z.boolean().optional(),
    current: z.boolean().optional(),
  })
  .passthrough();

export const NodeAgentRemoteConnectResultSchema = z
  .object({
    remote: z
      .object({
        id: IdSchema,
        url: z.string().trim().min(1).max(2048).optional(),
        keyId: IdSchema,
        pairedAt: TimestampSchema,
        active: z.boolean(),
      })
      .passthrough(),
    tunnel: z
      .object({
        status: z.enum(["disabled", "saved", "connecting", "connected", "failed"]),
        error: z.string().trim().max(2048).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const NodeAgentDeleteResponseSchema = z
  .object({
    deleted: z.boolean().optional(),
  })
  .passthrough();

export const LocalDockerImageSchema = z
  .object({
    repository: z.string().trim().optional(),
    tag: z.string().trim().optional(),
    id: z.string().trim(),
    createdSince: z.string().trim().optional(),
    size: z.string().trim().optional(),
    reference: z.string().trim().min(1),
    repoDigests: z.array(z.string().trim().min(1).max(512)).default([]),
  })
  .passthrough();

export const NodeImageAvailabilitySchema = z.object({
  image: ImageProfileSchema,
  status: z.enum(["available", "pull-required", "unknown"]),
  localImage: LocalDockerImageSchema.optional(),
  error: z.string().trim().max(2048).optional(),
}).strict();

export type NodeFolderTreeEntry = {
  name: string;
  path: string;
  children: NodeFolderTreeEntry[];
};

export const NodeFolderTreeEntrySchema: z.ZodType<NodeFolderTreeEntry> = z.lazy(() => z
  .object({
    name: z.string().trim().min(1),
    path: z.string().trim().min(1).max(4096),
    children: z.array(NodeFolderTreeEntrySchema),
  })
  .passthrough());

export const NodeAgentInstanceProxyRawResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    bodyBase64: z.string().optional(),
  })
  .passthrough();

export const InstanceTargetSchema = z
  .object({
    strategy: z.enum(["node-proxy", "direct-port", "kubernetes-ingress", "kubernetes-port-forward"]).default("node-proxy"),
    web: z.string().trim().max(2048).optional(),
    api: z.string().trim().max(2048).optional(),
    vnc: z.string().trim().max(2048).optional(),
    tty: z.string().trim().max(2048).optional(),
    logs: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
  })
  .strict();

export const InstanceAccessSchema = z
  .object({
    strategy: z.enum(["control-plane-proxy", "direct-port", "node-proxy", "kubernetes-ingress", "kubernetes-port-forward"]).default("control-plane-proxy"),
    web: z.string().trim().max(2048).optional(),
    api: z.string().trim().max(2048).optional(),
    ws: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
  })
  .strict()
  .default({ strategy: "control-plane-proxy", status: "unknown" });

export const WorkspaceStatusSchema = z
  .object({
    mode: z.enum(["local-bind", "git-clone", "empty-volume", "persistent-volume"]).optional(),
    status: z.enum(["unknown", "pending", "ready", "failed"]).default("unknown"),
    path: z.string().trim().max(4096).optional(),
    resolvedCommit: z.string().trim().max(120).optional(),
    error: z.string().trim().max(2048).optional(),
  })
  .passthrough();

export const ControlledInstanceSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    projectId: IdSchema.optional(),
    source: ProjectSourceSchema,
    sourceSnapshot: z.record(z.string(), z.unknown()).default({}),
    modelSelection: ModelSelectionSchema,
    nodeId: IdSchema,
    runtimeId: IdSchema,
    imageId: IdSchema.optional(),
    imageSnapshot: InstanceImageSnapshotSchema.optional(),
    imageProvisioning: ImageProvisioningSchema.optional(),
    status: z.enum(["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "failed", "unhealthy"]).default("created"),
    health: z.enum(["unknown", "ok", "degraded", "failed"]).default("unknown"),
    connectionStatus: z.enum(["unknown", "online", "offline", "endpoint-unreachable"]).default("unknown"),
    agentStatus: z.enum(["unknown", "online", "offline"]).default("unknown"),
    targetStatus: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
    uiAccessStatus: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
    controlMode: z.enum(["standalone", "controlled"]).default("controlled"),
    protocolVersion: ProtocolVersionSchema.optional(),
    instanceVersion: z.string().trim().max(80).optional(),
    build: BuildInfoSchema.optional(),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    appInventory: InstanceAppInventorySchema.optional(),
    config: z
      .object({
        autoImportAgentConfigs: z.boolean().default(true),
      })
      .strict()
      .default({ autoImportAgentConfigs: true }),
    workspace: WorkspaceStatusSchema.default({ status: "unknown" }),
    target: InstanceTargetSchema.default({ strategy: "direct-port", status: "unknown" }),
    access: InstanceAccessSchema,
    apps: z
      .object({
        runningCount: z.number().int().min(0).default(0),
        problemCount: z.number().int().min(0).default(0),
        updatedAt: TimestampSchema.optional(),
        revision: z.number().int().min(0).optional(),
      })
      .strict()
      .default({ runningCount: 0, problemCount: 0 }),
    aiSessions: AiSessionsSnapshotSchema.default(() => ({
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      sessions: [],
      updatedAt: new Date().toISOString(),
    })),
    triggers: z
      .object({
        enabledCount: z.number().int().min(0).default(0),
        runningCount: z.number().int().min(0).default(0),
        errorCount: z.number().int().min(0).default(0),
        configs: z.array(z.object({
          configHash: z.string().trim().min(1),
          config: TriggerConfigSchema,
          deployments: z.array(TriggerDeploymentSchema).default([]),
          runtime: z.array(TriggerRuntimeStateSchema).default([]),
        }).strict()).default([]),
        recentRuns: z.array(TriggerRunSchema).default([]),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        kind: z.string().trim().max(80).optional(),
        containerName: z.string().trim().max(240).optional(),
        containerId: z.string().trim().max(240).optional(),
        workspacePath: z.string().trim().max(4096).optional(),
        pid: z.number().int().positive().optional(),
        port: z.number().int().positive().max(65535).optional(),
        labels: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .default({ labels: {} }),
    registrationToken: z.string().trim().min(1).max(240).optional(),
    lastHeartbeatAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export function parseStoredControlledInstance(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void) {
  return ControlledInstanceSchema.parse(sanitizeStoredControlledInstance(input, onWarning));
}

export function safeParseStoredControlledInstance(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void) {
  return ControlledInstanceSchema.safeParse(sanitizeStoredControlledInstance(input, onWarning));
}

export function sanitizeStoredControlledInstance(
  input: unknown,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const source = input as Record<string, unknown>;
  const knownTopLevelKeys = new Set(Object.keys(ControlledInstanceSchema.shape));
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (knownTopLevelKeys.has(key)) {
      next[key] = value;
    } else {
      onWarning?.({
        instanceId: typeof source.id === "string" ? source.id : undefined,
        field: key,
      });
    }
  }
  if (source.capabilities && typeof source.capabilities === "object" && !Array.isArray(source.capabilities)) {
    const capabilities = { ...(source.capabilities as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(capabilities, "apps")) {
      onWarning?.({
        instanceId: typeof source.id === "string" ? source.id : undefined,
        field: "capabilities.apps",
      });
      delete capabilities.apps;
    }
    next.capabilities = capabilities;
  }
  next.appInventory = sanitizeStoredAppInventory(source.appInventory);
  next.apps = pickObjectFields(source.apps, ["runningCount", "problemCount", "updatedAt", "revision"]);
  next.config = pickObjectFields(source.config, ["autoImportAgentConfigs"]);
  next.modelSelection = pickObjectFields(source.modelSelection, ["codexModelHash", "claudeModelHash"]);
  next.imageSnapshot = sanitizeStoredInstanceImageSnapshot(
    source.imageSnapshot,
    source.imageId,
    onWarning,
    typeof source.id === "string" ? source.id : undefined,
  );
  next.imageProvisioning = pickObjectFields(source.imageProvisioning, ["phase", "requestedReference", "generation", "error", "startedAt", "updatedAt"]);
  next.runtime = pickObjectFields(source.runtime, ["kind", "containerName", "containerId", "workspacePath", "pid", "port", "labels"]);
  next.target = pickObjectFields(source.target ?? source.endpoints, ["strategy", "web", "api", "status"]);
  next.access = pickObjectFields(source.access, ["strategy", "web", "api", "ws", "status"]);
  return next;
}

function sanitizeStoredAppInventory(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const candidate = {
    observedAt: source.observedAt,
    items: Array.isArray(source.items)
      ? source.items.map((item) => {
          const picked = pickObjectFields(item, ["id", "name", "kind", "source", "availability", "diagnosticCode"]);
          if (!picked || typeof picked !== "object" || Array.isArray(picked)) return picked;
          return {
            ...picked,
            capabilities: pickObjectFields((item as Record<string, unknown>).capabilities, ["automation", "supportsCwdSelection"]),
          };
        })
      : source.items,
    issues: Array.isArray(source.issues)
      ? source.issues.map((issue) => pickObjectFields(issue, ["code", "message"]))
      : source.issues,
  };
  const parsed = InstanceAppInventorySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function pickObjectFields(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}

export const ControlledInstanceRegisterSchema = z
  .object({
    instanceId: IdSchema.optional(),
    name: z.string().trim().min(1).max(160),
    projectId: IdSchema.optional(),
    source: ProjectSourceSchema.optional(),
    nodeId: IdSchema.optional(),
    runtimeId: IdSchema.optional(),
    imageId: IdSchema.optional(),
    instanceVersion: z.string().trim().max(80).optional(),
    protocolVersion: ProtocolVersionSchema,
    build: BuildInfoSchema.optional(),
    controlMode: z.enum(["standalone", "controlled"]).default("controlled"),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    appInventory: InstanceAppInventorySchema.optional(),
    target: InstanceTargetSchema.default({ strategy: "direct-port", status: "unknown" }),
    workspace: WorkspaceStatusSchema.default({ status: "unknown" }),
    registrationToken: z.string().trim().max(240).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION && !value.appInventory) {
      context.addIssue({ code: "custom", path: ["appInventory"], message: "Current protocol register payload requires appInventory." });
    }
  });

export const ControlledInstanceHeartbeatSchema = z
  .object({
    status: ControlledInstanceSchema.shape.status.optional(),
    health: ControlledInstanceSchema.shape.health.optional(),
    protocolVersion: ProtocolVersionSchema,
    build: BuildInfoSchema.optional(),
    capabilities: ControlledInstanceSchema.shape.capabilities.optional(),
    appInventory: InstanceAppInventorySchema.optional(),
    apps: ControlledInstanceSchema.shape.apps.optional(),
    aiSessions: ControlledInstanceSchema.shape.aiSessions.optional(),
    triggers: ControlledInstanceSchema.shape.triggers.optional(),
    workspace: WorkspaceStatusSchema.optional(),
    target: InstanceTargetSchema.partial().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION && !value.appInventory) {
      context.addIssue({ code: "custom", path: ["appInventory"], message: "Current protocol heartbeat payload requires appInventory." });
    }
  });

export const ChatChannelSchema = z.enum(["web", "telegram", "wechat", "dingding"]);

export const ChatBridgeConfigSchema = z
  .object({
    id: IdSchema,
    channel: ChatChannelSchema,
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean().default(false),
    token: z.string().trim().max(4096).optional(),
    defaultChatId: z.string().trim().max(240).optional(),
    allowedUserIds: z.array(z.string().trim().min(1).max(240)).default([]),
    pollIntervalMs: z.number().int().positive().max(60000).default(3000),
    settings: z.record(z.string(), z.unknown()).default({}),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ChatSessionBindingSchema = z
  .object({
    id: IdSchema,
    channel: ChatChannelSchema,
    bridgeId: IdSchema.optional(),
    chatSessionId: z.string().trim().min(1).max(240),
    userId: z.string().trim().max(240).optional(),
    activeProjectId: IdSchema.optional(),
    activeInstanceId: IdSchema.optional(),
    activeAiSessionId: z.string().trim().min(1).max(120).optional(),
    lastUsedAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ChatGatewayMessageSchema = z
  .object({
    source: z
      .object({
        type: z.literal("chat-gateway").default("chat-gateway"),
        channel: ChatChannelSchema,
        bridgeId: IdSchema.optional(),
        chatSessionId: z.string().trim().min(1).max(240),
        userId: z.string().trim().max(240).optional(),
      })
      .strict(),
    message: z
      .object({
        text: z.string().trim().max(20000).default(""),
        attachments: z.array(AiSessionMessageAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
      })
      .strict()
      .superRefine((message, context) => {
        const totalBytes = message.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
        if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["attachments"],
            message: `Images must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`,
          });
        }
      }),
    target: z
      .object({
        instanceId: IdSchema,
        aiSessionId: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PendingRouteSchema = z
  .object({
    id: IdSchema,
    instanceId: IdSchema,
    projectId: IdSchema.optional(),
    aiSessionId: z.string().trim().min(1).max(120),
    providerSessionId: z.string().trim().max(240).optional(),
    result: z.string().default(""),
    timeoutMs: z.number().positive().optional(),
    source: z.string().trim().max(120).optional(),
    kind: z.enum(["task", "approval"]).default("task"),
    status: z.enum(["pending", "unreachable"]).default("pending"),
    error: z.string().trim().max(2048).optional(),
    lastSeenAt: TimestampSchema,
  })
  .strict();

export type GitRepository = z.infer<typeof GitRepositorySchema>;
export type NodeLocalFolder = z.infer<typeof NodeLocalFolderSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type NodeModelConfig = z.infer<typeof NodeModelConfigSchema>;
export type PublicModelConfig = z.infer<typeof PublicModelConfigSchema>;
export type NodeModelPublicRecord = z.infer<typeof NodeModelPublicRecordSchema>;
export type NodeModelAssignment = z.infer<typeof NodeModelAssignmentSchema>;
export type ModelLocation = z.infer<typeof ModelLocationSchema>;
export type FederatedModelGroup = z.infer<typeof FederatedModelGroupSchema>;
export type FederatedModelRegistry = z.infer<typeof FederatedModelRegistrySchema>;
export type ImageProfile = z.infer<typeof ImageProfileSchema>;
export type InstanceImageSnapshot = z.infer<typeof InstanceImageSnapshotSchema>;
export type ImageProvisioning = z.infer<typeof ImageProvisioningSchema>;
export type NodeImageAvailability = z.infer<typeof NodeImageAvailabilitySchema>;
export type Node = z.infer<typeof NodeSchema>;
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;
export type InstanceResourceMetrics = z.infer<typeof InstanceResourceMetricsSchema>;
export type NodeAgentHealth = z.infer<typeof NodeAgentHealthSchema>;
export type NodeAgentExternalListenerConfig = z.infer<typeof NodeAgentExternalListenerConfigSchema>;
export type NodeAgentExternalListener = z.infer<typeof NodeAgentExternalListenerSchema>;
export type UpdateNodeAgentExternalListener = z.infer<typeof UpdateNodeAgentExternalListenerSchema>;
export type NodeAgentPairingInviteResponse = z.infer<typeof NodeAgentPairingInviteResponseSchema>;
export type NodeAgentRemoteControlPlane = z.infer<typeof NodeAgentRemoteControlPlaneSchema>;
export type NodeAgentRemoteConnectResult = z.infer<typeof NodeAgentRemoteConnectResultSchema>;
export type NodeAgentDeleteResponse = z.infer<typeof NodeAgentDeleteResponseSchema>;
export type LocalDockerImage = z.infer<typeof LocalDockerImageSchema>;
export type NodeAgentInstanceProxyRawResponse = z.infer<typeof NodeAgentInstanceProxyRawResponseSchema>;
export type BuildInfo = z.infer<typeof BuildInfoSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;
export type UpdateTarget = z.infer<typeof UpdateTargetSchema>;
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;
export type UpdateCheckResult = z.infer<typeof UpdateCheckResultSchema>;
export type UpdateJob = z.infer<typeof UpdateJobSchema>;
export type ControlledInstance = z.infer<typeof ControlledInstanceSchema>;
export type InstanceAppInventory = z.infer<typeof InstanceAppInventorySchema>;
export type InstanceAppInventoryItem = z.infer<typeof InstanceAppInventoryItemSchema>;
export type FinalComputerPlatform = z.infer<typeof FinalComputerPlatformSchema>;
export type FinalComputerArch = z.infer<typeof FinalComputerArchSchema>;
export type AppInstaller = z.infer<typeof AppInstallerSchema>;
export type AppInstallPrivilege = z.infer<typeof AppInstallPrivilegeSchema>;
export type FinalComputerCapabilities = z.infer<typeof FinalComputerCapabilitiesSchema>;
export type ManagedAppState = z.infer<typeof ManagedAppStateSchema>;
export type ManagedAppManagementSource = z.infer<typeof ManagedAppManagementSourceSchema>;
export type ManagedAppActionReason = z.infer<typeof ManagedAppActionReasonSchema>;
export type ManagedAppProjection = z.infer<typeof ManagedAppProjectionSchema>;
export type AppManagementOperation = z.infer<typeof AppManagementOperationSchema>;
export type AppManagementJobState = z.infer<typeof AppManagementJobStateSchema>;
export type AppManagementProgress = z.infer<typeof AppManagementProgressSchema>;
export type AppManagementError = z.infer<typeof AppManagementErrorSchema>;
export type AppManagementJob = z.infer<typeof AppManagementJobSchema>;
export type AppManagementSnapshot = z.infer<typeof AppManagementSnapshotSchema>;
export type AppManagementOperationRequest = z.infer<typeof AppManagementOperationRequestSchema>;
export type AppManagementJobResponse = z.infer<typeof AppManagementJobResponseSchema>;
export type AppManagementEvent = z.infer<typeof AppManagementEventSchema>;
export type ControlledInstanceRegister = z.infer<typeof ControlledInstanceRegisterSchema>;
export type ControlledInstanceHeartbeat = z.infer<typeof ControlledInstanceHeartbeatSchema>;
export type ChatSessionBinding = z.infer<typeof ChatSessionBindingSchema>;
export type ChatBridgeConfig = z.infer<typeof ChatBridgeConfigSchema>;
export type ChatGatewayMessage = z.infer<typeof ChatGatewayMessageSchema>;
export type PendingRoute = z.infer<typeof PendingRouteSchema>;
