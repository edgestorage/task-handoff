import path from "node:path";
import { z } from "zod";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  ControlledInstanceSchema,
  InstanceImageSnapshotSchema,
  NodeLocalFolderSchema,
  NodeRuntimeSchema,
  NodeSchema,
  ProjectSchema,
  ProjectSourceSchema,
  WorkspacePolicySchema,
  safeParseStoredControlledInstance,
  sanitizeStoredControlledInstance,
  sanitizeStoredNodeLocalFolder,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type ControlledInstanceRegister,
  type Node,
  type NodeLocalFolder,
  type NodeRuntime,
  type Project,
} from "@task-handoff/protocol/control-plane";
import { JsonCollection, createId, createSecret } from "../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "./persistence/paths.ts";
import {
  CreateLocalFolderSchema,
  CreateNodeInstanceSchema,
  CreateNodeRuntimeSchema,
  UpdateNodeRuntimeSchema,
} from "./schemas.ts";
import { NodeModelRegistry } from "./models/registry.ts";
import { NodeUpdateJobs } from "./updates.ts";
import { EnvironmentTemplateStore } from "./environment-templates/store.ts";
import { InstancePrivateConfigStore } from "./instances/private-config-store.ts";
import {
  desiredControlledInstanceVersion,
  runtimeVersionStateForActual,
  runtimeVersionStateForReport,
} from "./runtime-version-state.ts";
import { reduceInstanceLifecycle, type InstanceLifecycleEvent } from "./instance-lifecycle-state.ts";
import type { ExecutorContext } from "./runtimes/docker.ts";
import type { RuntimeAdapter } from "./runtimes/adapters.ts";

const BUILTIN_LOCAL_RUNTIME_ID = "runtime_local_host";
const BUILTIN_RUNTIME_LABEL = "task-handoff.node-agent.builtin";

function now() {
  return new Date().toISOString();
}

function userRuntimeLabels(labels: Record<string, string> | undefined) {
  const sanitized = { ...labels };
  delete sanitized[BUILTIN_RUNTIME_LABEL];
  return sanitized;
}

function workspacePolicyForSource(source: Project["source"]) {
  if (source.type === "local-folder") {
    return WorkspacePolicySchema.parse({ mode: "local-bind", path: "/workspace", readOnly: false });
  }
  return WorkspacePolicySchema.parse({ mode: "git-clone", path: "/workspace", readOnly: false });
}

function managedVolumesForDockerInstance(instanceId: string, nodeId: string, source: Project["source"]) {
  const containerName = `task-handoff-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  const roles = [
    { role: "data" as const, suffix: "data", mountPath: "/data" },
    { role: "agent-home" as const, suffix: "agent-home", mountPath: "/home/agent" },
    ...(source.type === "local-folder" ? [] : [{ role: "workspace" as const, suffix: "workspace", mountPath: "/workspace" }]),
  ];
  return roles.map(({ role, suffix, mountPath }) => ({
    role,
    name: `${containerName}-${suffix}`,
    mountPath,
    labels: {
      "task-handoff.owner": "task-handoff",
      "task-handoff.instance-id": instanceId,
      "task-handoff.node-id": nodeId,
      "task-handoff.volume-role": role,
    },
  }));
}

function projectForInstance(instance: ControlledInstance): Project {
  const source = ProjectSourceSchema.parse(instance.source);
  const projectId =
    instance.projectId ||
    (source.type === "local-folder" ? source.localFolderId : undefined) ||
    (source.type === "git-repository" ? source.repositoryId : undefined) ||
    (source.type === "git-template" ? source.templateId : undefined) ||
    `project_${instance.id}`;
  return ProjectSchema.parse({
    id: projectId,
    name: typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : instance.name,
    source,
    defaultImageSelection: instance.imageSelection,
    defaultNodeId: instance.nodeId,
    defaultRuntimeId: instance.runtimeId,
    workspacePolicy: workspacePolicyForSource(source),
    labels: {},
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  });
}

function throwForbidden(code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode: 403, code });
}

function throwConflict(code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409, code });
}

function warnProtocolVersion(protocolVersion: string, peer: string) {
  if (protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION) return;
  console.warn(JSON.stringify({
    message: "protocol version mismatch",
    peer,
    expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    actualProtocolVersion: protocolVersion || "missing",
    errorCode: "PROTOCOL_VERSION_MISMATCH",
  }));
}

function storedInstancePayloadError(id: string, issues: Array<{ path: PropertyKey[]; message: string }>) {
  const detail = issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return Object.assign(
    new Error(`Stored instance ${id} is not compatible with protocol ${CONTROL_PLANE_PROTOCOL_VERSION}: ${detail}`),
    { statusCode: 409, code: "NODE_INSTANCE_PAYLOAD_INVALID" },
  );
}

function runtimeRequiresImage(runtime: NodeRuntime) {
  if (typeof runtime.capabilities.requiresImage === "boolean") return runtime.capabilities.requiresImage;
  return runtime.type !== "local";
}

export function runtimeUsesManagedArtifacts(runtime: NodeRuntime) {
  return runtime.capabilities.artifactKind !== "none";
}

export function localRuntimeCapabilities(capabilities: Record<string, unknown> = {}) {
  return {
    ...capabilities,
    requiresImage: false,
    supportsControlledInstanceApi: true,
    supportsContainerLifecycle: false,
    supportsAppSessions: true,
    supportsHostSessions: true,
    artifactKind: "none",
    isolation: "none",
  };
}

function defaultAccessStrategyForRuntime(type: NodeRuntime["type"]) {
  return type === "docker" ? "direct-port" as const : "node-proxy" as const;
}

export class ControlledInstanceCollection extends JsonCollection<ControlledInstance> {
  private onStored?: (instance: ControlledInstance) => void;
  private readonly privateConfigs: InstancePrivateConfigStore;

  constructor(
    directory: string,
    options: ConstructorParameters<typeof JsonCollection<ControlledInstance>>[1],
    privateConfigs: InstancePrivateConfigStore,
  ) {
    super(directory, options);
    this.privateConfigs = privateConfigs;
  }

  setOnStored(listener: (instance: ControlledInstance) => void) {
    this.onStored = listener;
  }

  override put(record: ControlledInstance) {
    const persistedRevision = super.get(record.id)?.stateRevision || 0;
    const existingPrivateConfig = this.privateConfigs.get(record.id);
    const instanceCredential = record.registrationToken || existingPrivateConfig?.instanceCredential;
    if (instanceCredential) {
      this.privateConfigs.materialize(record.id, instanceCredential, existingPrivateConfig?.environment || {});
    }
    const { registrationToken: _registrationToken, ...persistentRecord } = record;
    const stored = super.put(ControlledInstanceSchema.parse({
      ...persistentRecord,
      stateRevision: Math.max(record.stateRevision || 0, persistedRevision) + 1,
    }));
    const hydrated = this.hydrate(stored);
    this.onStored?.(hydrated);
    return hydrated;
  }

  override get(id: string) {
    const stored = super.get(id);
    return stored ? this.hydrate(stored) : undefined;
  }

  override list() {
    return super.list().map((instance) => this.hydrate(instance));
  }

  private hydrate(instance: ControlledInstance) {
    const instanceCredential = this.privateConfigs.get(instance.id)?.instanceCredential || instance.registrationToken;
    return ControlledInstanceSchema.parse({
      ...instance,
      registrationToken: instanceCredential,
    });
  }
}

export class NodeAgentState {
  readonly nodeId: string;
  readonly paths: NodeAgentStorePaths;
  readonly localFolders: JsonCollection<NodeLocalFolder>;
  readonly nodeRuntimes: JsonCollection<NodeRuntime>;
  readonly controlledInstances: ControlledInstanceCollection;
  readonly environmentTemplates: EnvironmentTemplateStore;
  readonly instancePrivateConfigs: InstancePrivateConfigStore;
  readonly modelRegistry: NodeModelRegistry;
  readonly updateJobs: NodeUpdateJobs;
  readonly node: Node;
  private listenerPort: number;
  private readonly containerUrlOverride?: string;
  private readonly platform: NodeJS.Platform;

  constructor(paths: NodeAgentStorePaths, nodeId: string, endpoint: string | undefined, containerUrl: string | undefined, listenerPort: number, platform: NodeJS.Platform) {
    this.paths = paths;
    this.nodeId = nodeId;
    this.localFolders = new JsonCollection(paths.localFoldersDir, { schema: NodeLocalFolderSchema, sanitize: sanitizeStoredNodeLocalFolder });
    this.nodeRuntimes = new JsonCollection(paths.nodeRuntimesDir, { schema: NodeRuntimeSchema });
    this.instancePrivateConfigs = new InstancePrivateConfigStore(paths);
    this.controlledInstances = new ControlledInstanceCollection(paths.controlledInstancesDir, {
      schema: ControlledInstanceSchema,
      sanitize: (value) => sanitizeStoredControlledInstance(value, (warning) => {
        console.warn(JSON.stringify({
          message: "legacy controlled instance field was ignored",
          ...warning,
        }));
      }),
    }, this.instancePrivateConfigs);
    this.environmentTemplates = new EnvironmentTemplateStore(paths);
    this.modelRegistry = new NodeModelRegistry(paths, nodeId, {
      has: (id) => Boolean(this.controlledInstances.get(id)),
      list: () => this.listInstances(),
      require: (id) => this.requireInstance(id),
      put: (instance) => this.controlledInstances.put(instance),
    });
    this.updateJobs = new NodeUpdateJobs(paths);
    this.listenerPort = listenerPort;
    this.platform = platform;
    this.containerUrlOverride = containerUrl;
    const timestamp = now();
    this.node = NodeSchema.parse({
      id: nodeId,
      name: nodeId,
      connectionMode: "direct-http",
      endpoint,
      controlEndpoint: endpoint,
      containerEndpoint: this.containerUrl,
      publicWebBase: endpoint ? endpoint.replace(/:\d+$/, "") : undefined,
      status: "online",
      health: "ok",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  init() {
    this.localFolders.init();
    for (const folder of this.localFolders.list()) this.localFolders.put(folder);
    this.nodeRuntimes.init();
    this.instancePrivateConfigs.init();
    this.controlledInstances.init();
    this.environmentTemplates.init();
    this.modelRegistry.init();
    this.updateJobs.init();
    this.updateJobs.reconcileRollouts(this.controlledInstances.list(), desiredControlledInstanceVersion(), { processStarted: true });
    if (!this.nodeRuntimes.get("runtime_local_docker")) {
      const timestamp = now();
      this.nodeRuntimes.put(
        NodeRuntimeSchema.parse({
          id: "runtime_local_docker",
          nodeId: this.nodeId,
          name: "Local Docker",
          type: "docker",
          status: "unknown",
          accessStrategy: "direct-port",
          capabilities: {},
          labels: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    if (this.platform !== "win32") {
      const current = this.nodeRuntimes.get(BUILTIN_LOCAL_RUNTIME_ID);
      const timestamp = now();
      this.nodeRuntimes.put(NodeRuntimeSchema.parse({
        id: BUILTIN_LOCAL_RUNTIME_ID,
        nodeId: this.nodeId,
        name: "Local Runtime",
        type: "local",
        status: current?.status || "unknown",
        accessStrategy: "node-proxy",
        capabilities: localRuntimeCapabilities(current?.capabilities),
        labels: { ...current?.labels, [BUILTIN_RUNTIME_LABEL]: "true" },
        createdAt: current?.createdAt || timestamp,
        updatedAt: current?.updatedAt || timestamp,
      }));
    }
    for (const runtime of this.nodeRuntimes.list()) {
      if (runtime.nodeId !== this.nodeId) {
        this.nodeRuntimes.put(NodeRuntimeSchema.parse({ ...runtime, nodeId: this.nodeId, updatedAt: now() }));
      }
    }
    for (const folder of this.localFolders.list()) {
      if (folder.nodeId !== this.nodeId) {
        this.localFolders.put(NodeLocalFolderSchema.parse({ ...folder, nodeId: this.nodeId, updatedAt: now() }));
      }
    }
    this.normalizeInstanceRuntimeVersions();
  }

  private normalizeInstanceRuntimeVersions() {
    for (const instance of this.controlledInstances.list()) {
      const actualVersion = instance.build?.packageVersion || instance.instanceVersion;
      const derived = runtimeVersionStateForActual(actualVersion);
      const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(instance.runtimeId));
      const stopped = ["created", "stopped", "failed"].includes(instance.status);
      const previous = managedArtifacts && instance.runtimeVersion?.desiredVersion === derived.desiredVersion ? instance.runtimeVersion : undefined;
      const runtimeVersion = !managedArtifacts
        ? derived
        : derived.phase === "matched"
        ? (stopped ? derived : { ...derived, phase: "verifying" as const, matchedAt: undefined })
        : previous?.phase === "failed"
          ? { ...derived, phase: "failed" as const, attempt: previous.attempt, lastAttemptAt: previous.lastAttemptAt, error: previous.error }
          : { ...derived, attempt: previous?.attempt || 0, lastAttemptAt: previous?.lastAttemptAt };
      this.controlledInstances.put(ControlledInstanceSchema.parse({
        ...instance,
        ready: false,
        runtimeVersion,
        updatedAt: now(),
      }));
    }
  }

  get localNodeAgentUrl() {
    return `http://127.0.0.1:${this.listenerPort}`;
  }

  get currentListenerPort() {
    return this.listenerPort;
  }

  get containerUrl() {
    return this.containerUrlOverride || `http://host.docker.internal:${this.listenerPort}`;
  }

  setListenerPort(port: number) {
    this.listenerPort = port;
    this.node.containerEndpoint = this.containerUrl;
    this.node.updatedAt = now();
  }

  runningInstanceCount() {
    const inactive = new Set<ControlledInstance["status"]>(["created", "stopped", "failed"]);
    return this.listInstances().filter((instance) => !inactive.has(instance.status)).length;
  }

  createLocalFolder(input: z.infer<typeof CreateLocalFolderSchema>) {
    const timestamp = now();
    const folder = NodeLocalFolderSchema.parse({
      ...input,
      id: input.id || createId("folder"),
      nodeId: this.nodeId,
      labels: input.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.localFolders.put(folder);
  }

  createRuntime(input: z.infer<typeof CreateNodeRuntimeSchema>) {
    if (input.type === "local") {
      const unsupported = this.platform === "win32";
      const error = new Error(unsupported
        ? "Local Runtime is not supported on Windows."
        : "Local Runtime is built in and cannot be added manually.");
      Object.assign(error, { statusCode: unsupported ? 400 : 409, code: unsupported ? "LOCAL_RUNTIME_UNSUPPORTED" : "LOCAL_RUNTIME_BUILTIN" });
      throw error;
    }
    const timestamp = now();
    const runtime = NodeRuntimeSchema.parse({
      ...input,
      id: input.id || createId("runtime"),
      nodeId: this.nodeId,
      accessStrategy: input.accessStrategy || defaultAccessStrategyForRuntime(input.type),
      capabilities: input.capabilities || {},
      labels: userRuntimeLabels(input.labels),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.nodeRuntimes.put(runtime);
  }

  updateRuntime(id: string, input: z.infer<typeof UpdateNodeRuntimeSchema>) {
    const current = this.requireRuntime(id);
    if (current.labels[BUILTIN_RUNTIME_LABEL] === "true") {
      const error = new Error(`Built-in runtime ${id} cannot be modified.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_BUILTIN" });
      throw error;
    }
    if (current.type === "local" || input.type === "local") {
      const unsupported = this.platform === "win32";
      const error = new Error(unsupported
        ? "Local Runtime is not supported on Windows."
        : "Local Runtime is built in and cannot be configured manually.");
      Object.assign(error, { statusCode: unsupported ? 400 : 409, code: unsupported ? "LOCAL_RUNTIME_UNSUPPORTED" : "LOCAL_RUNTIME_BUILTIN" });
      throw error;
    }
    const updated = NodeRuntimeSchema.parse({
      ...current,
      ...input,
      id: current.id,
      nodeId: this.nodeId,
      accessStrategy: input.accessStrategy || current.accessStrategy,
      capabilities: input.capabilities || current.capabilities,
      labels: input.labels ? userRuntimeLabels(input.labels) : current.labels,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    return this.nodeRuntimes.put(updated);
  }

  deleteRuntime(id: string) {
    const runtime = this.requireRuntime(id);
    if (runtime.labels[BUILTIN_RUNTIME_LABEL] === "true") {
      const error = new Error(`Built-in runtime ${id} cannot be deleted.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_BUILTIN" });
      throw error;
    }
    const references = this.listInstances().filter((instance) => instance.runtimeId === id);
    if (references.length) {
      const error = new Error(`Runtime ${id} is used by ${references.length} instance${references.length === 1 ? "" : "s"}.`);
      Object.assign(error, { statusCode: 409, code: "NODE_RUNTIME_IN_USE" });
      throw error;
    }
    return this.nodeRuntimes.delete(id);
  }

  checkRuntime(id: string, adapter: RuntimeAdapter) {
    const runtime = this.requireRuntime(id);
    if (!adapter.check) {
      return this.nodeRuntimes.put(NodeRuntimeSchema.parse({ ...runtime, status: "unknown", updatedAt: now() }));
    }
    return adapter.check(runtime).then((patch) => {
      const updated = NodeRuntimeSchema.parse({
        ...runtime,
        ...patch,
        id: runtime.id,
        nodeId: this.nodeId,
        createdAt: runtime.createdAt,
        updatedAt: now(),
      });
      return this.nodeRuntimes.put(updated);
    });
  }

  requireRuntime(id: string) {
    const runtime = this.nodeRuntimes.get(id);
    if (!runtime) {
      const error = new Error(`Node runtime ${id} was not found.`);
      Object.assign(error, { statusCode: 404, code: "NODE_RUNTIME_NOT_FOUND" });
      throw error;
    }
    return runtime;
  }

  requireInstance(id: string) {
    const instance = this.controlledInstances.get(id);
    if (!instance) {
      const error = new Error(`Instance ${id} was not found on node ${this.nodeId}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_INSTANCE_NOT_FOUND" });
      throw error;
    }
    const parsed = safeParseStoredControlledInstance(instance);
    if (!parsed.success) {
      throw storedInstancePayloadError(id, parsed.error.issues);
    }
    return parsed.data;
  }

  applyInstanceLifecycle(id: string, event: InstanceLifecycleEvent) {
    return this.controlledInstances.put(reduceInstanceLifecycle(this.requireInstance(id), event));
  }

  listInstances() {
    return this.controlledInstances.list().flatMap((instance) => {
      const parsed = safeParseStoredControlledInstance(instance);
      return parsed.success ? [parsed.data] : [];
    });
  }

  resolvedAssignedModelEnvironment(instanceId: string) {
    return this.modelRegistry.resolvedEnvironment(instanceId);
  }

  createInstance(input: z.infer<typeof CreateNodeInstanceSchema>) {
    const runtime = this.requireRuntime(input.runtimeId);
    const timestamp = now();
    const id = input.id || createId("inst");
    const source = ProjectSourceSchema.parse(input.source);
    const environmentSource = input.environmentSource || (input.imageSelection ? { type: "image" as const, imageSelection: input.imageSelection } : undefined);
    if (environmentSource?.type === "template" && runtime.type !== "docker") {
      const error = new Error(`Runtime ${runtime.name} does not support environment templates.`);
      Object.assign(error, { statusCode: 409, code: "ENVIRONMENT_TEMPLATE_RUNTIME_UNSUPPORTED" });
      throw error;
    }
    const environmentTemplate = environmentSource?.type === "template" ? this.environmentTemplates.get(environmentSource.environmentTemplateId) : undefined;
    if (environmentSource?.type === "template" && (!environmentTemplate || environmentTemplate.status !== "ready")) {
      const error = new Error(`Environment template ${environmentSource.environmentTemplateId} is not ready on node ${this.nodeId}.`);
      Object.assign(error, { statusCode: environmentTemplate ? 409 : 404, code: environmentTemplate ? "ENVIRONMENT_TEMPLATE_NOT_READY" : "ENVIRONMENT_TEMPLATE_NOT_FOUND" });
      throw error;
    }
    if (environmentTemplate && environmentTemplate.nodeId !== this.nodeId) {
      const error = new Error(`Environment template ${environmentTemplate.id} belongs to node ${environmentTemplate.nodeId}, not ${this.nodeId}.`);
      Object.assign(error, { statusCode: 409, code: "ENVIRONMENT_TEMPLATE_NODE_MISMATCH" });
      throw error;
    }
    if (runtimeRequiresImage(runtime) && (!environmentSource || (environmentSource.type === "image" && !input.image))) {
      const error = new Error(`Runtime ${runtime.name} requires an image.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_IMAGE_REQUIRED" });
      throw error;
    }
    if (runtime.type === "local" && source.type !== "local-folder") {
      const error = new Error("Localhost runtime currently supports local folder sources only.");
      Object.assign(error, { statusCode: 400, code: "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" });
      throw error;
    }
    if (runtime.type === "local" && this.listInstances().some((instance) => this.requireRuntime(instance.runtimeId).type === "local")) {
      const error = new Error("A localhost instance already exists on this node.");
      Object.assign(error, { statusCode: 409, code: "LOCAL_RUNTIME_INSTANCE_EXISTS" });
      throw error;
    }
    const imageSnapshot = environmentTemplate
      ? InstanceImageSnapshotSchema.parse({
          id: environmentTemplate.id,
          origin: "custom",
          name: environmentTemplate.name,
          repository: "task-handoff/environment-template",
          tag: environmentTemplate.id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
          requestedReference: environmentTemplate.internalTag,
          resolvedDigest: environmentTemplate.imageId,
          resolvedReference: environmentTemplate.internalTag,
          downloadSizeBytes: environmentTemplate.sizeBytes || undefined,
          pullPolicy: "if-not-present",
          capabilities: [],
          optionalApps: [],
          defaultEnv: {},
          labels: {},
          createdAt: environmentTemplate.createdAt,
          updatedAt: environmentTemplate.updatedAt,
        })
      : input.image ? InstanceImageSnapshotSchema.parse(input.image) : undefined;
    const workspacePath = runtime.type === "local" && source.type === "local-folder" ? path.resolve(source.path) : undefined;
    const instance = ControlledInstanceSchema.parse({
      id,
      name: input.name || `instance-${id.replace(/^inst_?/, "").slice(0, 6)}`,
      source,
      sourceSnapshot: input.sourceSnapshot || {},
      modelSelection: input.modelSelection,
      projectId: input.projectId,
      nodeId: this.nodeId,
      runtimeId: runtime.id,
      imageSelection: environmentSource?.type === "image" ? environmentSource.imageSelection : undefined,
      environmentSource,
      environmentTemplateOrigin: environmentTemplate ? {
        templateId: environmentTemplate.id,
        nodeId: environmentTemplate.nodeId,
        imageId: environmentTemplate.imageId,
        name: environmentTemplate.name,
        platform: environmentTemplate.platform,
        architecture: environmentTemplate.architecture,
      } : undefined,
      imageSnapshot,
      imageProvisioning: imageSnapshot && runtime.type === "docker" && environmentSource?.type !== "template" ? {
        phase: "checking-image",
        requestedReference: imageSnapshot.requestedReference,
        generation: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      } : undefined,
      status: imageSnapshot && runtime.type === "docker" && environmentSource?.type !== "template" ? "provisioning" : "created",
      health: "unknown",
      connectionStatus: "unknown",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      controlMode: "controlled",
      ready: false,
      runtimeVersion: runtimeVersionStateForActual(),
      capabilities: {},
      config: {
        autoImportAgentConfigs: input.config?.autoImportAgentConfigs ?? true,
        defaultCodexPermissionMode: input.config?.defaultCodexPermissionMode ?? (runtime.type === "docker" ? "full-access" : "ask"),
      },
      workspace: runtime.type === "local" ? { mode: "local-bind", status: "unknown", path: workspacePath } : { status: "unknown" },
      target: { strategy: "node-proxy", status: "unknown" },
      runtime: runtime.type === "local"
        ? { kind: "local", workspacePath, labels: { "task-handoff.runtime-kind": "local" }, managedVolumes: [] }
        : { labels: {}, managedVolumes: managedVolumesForDockerInstance(id, this.nodeId, source) },
      registrationToken: createSecret(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const stored = this.controlledInstances.put(instance);
    this.instancePrivateConfigs.materialize(stored.id, stored.registrationToken, this.resolvedAssignedModelEnvironment(stored.id));
    return stored;
  }

  registerInstance(id: string, input: ControlledInstanceRegister, token?: string) {
    const parsed = ControlledInstanceRegisterSchema.parse(input);
    const timestamp = now();
    const existing = this.controlledInstances.get(id);
    if (!existing) {
      const error = new Error(`Instance ${id} was not found on node ${this.nodeId}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_INSTANCE_NOT_FOUND" });
      throw error;
    }
    this.validateInstanceReport(existing, parsed, token);
    if (parsed.processIncarnationId && parsed.processIncarnationId === existing.processIncarnationId) {
      return existing;
    }
    warnProtocolVersion(parsed.protocolVersion, `Instance ${id}`);
    const actualVersion = parsed.build?.packageVersion || parsed.instanceVersion;
    const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(existing.runtimeId));
    const runtimeVersion = runtimeVersionStateForReport(existing, actualVersion, managedArtifacts);
    const updated = ControlledInstanceSchema.parse({
      ...existing,
      status: "registered",
      health: actualVersion === desiredControlledInstanceVersion() ? "ok" : "degraded",
      // Managed releases require inspection before they are ready. A Local
      // Runtime process is the controlled instance bundled with this program.
      ready: !managedArtifacts && actualVersion === desiredControlledInstanceVersion(),
      connectionStatus: "online",
      agentStatus: "online",
      targetStatus: parsed.target.status === "endpoint-unreachable" ? "endpoint-unreachable" : parsed.target.status === "reachable" ? "reachable" : existing.targetStatus,
      uiAccessStatus: parsed.target.status === "endpoint-unreachable" ? "endpoint-unreachable" : existing.uiAccessStatus,
      controlMode: parsed.controlMode,
      protocolVersion: parsed.protocolVersion,
      instanceVersion: parsed.instanceVersion,
      build: parsed.build,
      runtimeVersion,
      processIncarnationId: parsed.processIncarnationId || existing.processIncarnationId,
      capabilities: parsed.capabilities,
      appInventory: parsed.appInventory,
      workspace: parsed.workspace,
      target: { ...existing.target, ...parsed.target },
      registrationToken: existing.registrationToken || parsed.registrationToken,
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    });
    return this.controlledInstances.put(updated);
  }

  heartbeatInstance(id: string, input: ControlledInstanceHeartbeat, token?: string) {
    const current = this.requireInstance(id);
    this.validateInstanceToken(current, token);
    const parsed = ControlledInstanceHeartbeatSchema.parse(input);
    if (current.processIncarnationId && parsed.processIncarnationId && parsed.processIncarnationId !== current.processIncarnationId) {
      throwConflict(
        "INSTANCE_PROCESS_INCARNATION_MISMATCH",
        `Instance ${id} report belongs to an obsolete controlled-instance process.`,
      );
    }
    warnProtocolVersion(parsed.protocolVersion, `Instance ${id}`);
    const timestamp = now();
    const mergedTarget = parsed.target ? { ...current.target, ...parsed.target } : current.target;
    const target = {
      ...mergedTarget,
      status: mergedTarget.status === "unknown" && (mergedTarget.web || mergedTarget.api) ? "reachable" as const : mergedTarget.status,
    };
    const targetStatus = target.status === "endpoint-unreachable" ? "endpoint-unreachable" : target.status === "reachable" ? "reachable" : current.targetStatus;
    const actualVersion = parsed.build?.packageVersion || current.build?.packageVersion || current.instanceVersion;
    const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(current.runtimeId));
    const runtimeVersion = runtimeVersionStateForReport(current, actualVersion, managedArtifacts);
    const reportedHealth = parsed.health || current.health;
    const authoritativeReady = (parsed.status || current.status) === "running" && reportedHealth !== "failed";
    const updated = ControlledInstanceSchema.parse({
      ...current,
      ...parsed,
      target,
      ready: authoritativeReady,
      health: reportedHealth,
      runtimeVersion,
      processIncarnationId: parsed.processIncarnationId || current.processIncarnationId,
      agentStatus: "online",
      targetStatus,
      uiAccessStatus: targetStatus,
      connectionStatus: "online",
      build: parsed.build || current.build,
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    });
    return this.controlledInstances.put(updated);
  }

  private validateInstanceReport(existing: ControlledInstance, input: ControlledInstanceRegister, token?: string) {
    this.validateInstanceToken(existing, token || input.registrationToken);
    if (input.instanceId && input.instanceId !== existing.id) {
      throwForbidden("INSTANCE_ID_MISMATCH", `Instance ${input.instanceId} cannot register as ${existing.id}.`);
    }
    if (input.nodeId && input.nodeId !== this.nodeId) {
      throwForbidden("INSTANCE_NODE_MISMATCH", `Instance ${existing.id} belongs to node ${this.nodeId}.`);
    }
    if (input.runtimeId && input.runtimeId !== existing.runtimeId) {
      throwForbidden("INSTANCE_RUNTIME_MISMATCH", `Instance ${existing.id} belongs to runtime ${existing.runtimeId}.`);
    }
    if (input.imageSelection && input.imageSelection.imageId !== existing.imageSelection?.imageId) {
      throwForbidden("INSTANCE_IMAGE_MISMATCH", `Instance ${existing.id} belongs to image ${existing.imageSelection?.imageId}.`);
    }
  }

  private validateInstanceToken(instance: ControlledInstance, token?: string) {
    if (!instance.registrationToken || token !== instance.registrationToken) {
      throwForbidden("INSTANCE_REGISTRATION_TOKEN_INVALID", `Invalid registration token for instance ${instance.id}.`);
    }
  }

  context(instance: ControlledInstance, modelEnv: Record<string, string> = this.resolvedAssignedModelEnvironment(instance.id)): ExecutorContext {
    const image = instance.imageSnapshot || InstanceImageSnapshotSchema.parse({ id: "img_localhost", origin: "custom", name: "Localhost", repository: "localhost", tag: "local", requestedReference: "localhost:local", pullPolicy: "if-not-present", capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: instance.createdAt, updatedAt: instance.updatedAt });
    const privateConfig = this.instancePrivateConfigs.materialize(instance.id, instance.registrationToken, modelEnv);
    return {
      project: projectForInstance(instance),
      image,
      node: this.node,
      runtime: this.requireRuntime(instance.runtimeId),
      instance,
      nodeAgentUrl: this.containerUrl,
      modelEnv,
      privateConfigPath: this.instancePrivateConfigs.filePath(privateConfig.instanceId),
    };
  }
}
