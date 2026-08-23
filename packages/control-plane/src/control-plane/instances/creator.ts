import type {
  ControlledInstance,
  Node,
  NodeLocalFolder,
  NodeRuntime,
  Project,
  SelectableImage,
} from "@task-handoff/protocol/control-plane";
import { ProjectSourceSchema, projectSourceWithoutGitCredential, supportsNodeAiSessionFileAttachmentLimit, supportsNodeGitCredentialRuntimeBroker, supportsNodeGitWorkspaceProvisioning, supportsNodeManagedGitCredentialRegistry } from "@task-handoff/protocol/control-plane";
import { resolveGitCredential, type GitCredentialRetention, type GitWorkspaceProvisioningInput } from "@task-handoff/protocol/managed-git-credentials";
import { CreateInstanceInputSchema } from "../application/inputs.ts";
import type { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { now } from "../application/helpers.ts";
import { publicInstanceWithAccess } from "../public-records.ts";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneGitCredentialService } from "../git-credentials/service.ts";

type ControlledInstanceCreatorOptions = {
  gateway: ControlPlaneNodeAgentGateway;
  defaultNodeId: () => string | undefined;
  requireProject: (id: string) => Project;
  requireNode: (id: string) => Node;
  requireRuntime: (nodeId: string, runtimeId: string) => Promise<NodeRuntime>;
  requireLocalFolder: (node: Node, folderId: string) => Promise<NodeLocalFolder>;
  resolveImageSelection: (selection: { imageId: string; tag?: string }) => SelectableImage;
  prepareModels: (
    node: Node,
    selection: { codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null },
  ) => Promise<unknown>;
  gitCredentials: ControlPlaneGitCredentialService;
};

export class ControlledInstanceCreator {
  private readonly options: ControlledInstanceCreatorOptions;

  constructor(options: ControlledInstanceCreatorOptions) {
    this.options = options;
  }

  async create(input: unknown) {
    const parsedInput = CreateInstanceInputSchema.parse(input);
    const project = parsedInput.projectId ? this.options.requireProject(parsedInput.projectId) : undefined;
    const runtimeId = parsedInput.runtimeId || "runtime_local_docker";
    const nodeId = parsedInput.nodeId || project?.defaultNodeId || this.options.defaultNodeId();
    if (!nodeId) {
      throw publicError("At least one node connection is required before creating an instance.", 400, "NODE_REQUIRED");
    }
    const node = this.options.requireNode(nodeId);
    const agent = node.capabilities.agent;
    const agentCapabilities = agent && typeof agent === "object" && !Array.isArray(agent)
      ? (agent as Record<string, unknown>).capabilities
      : undefined;
    if (parsedInput.config?.aiSessionMaxFileAttachmentBytes !== undefined) {
      if (!supportsNodeAiSessionFileAttachmentLimit(agentCapabilities)) {
        // Compatibility for v0.0.21: older node agents reject the additive instance config field.
        throw publicError("This node does not support managed AI session file attachment limits.", 409, "AI_SESSION_FILE_ATTACHMENT_LIMIT_UNSUPPORTED");
      }
    }
    const runtime = await this.options.requireRuntime(node.id, runtimeId);
    const requiresImage = runtime.capabilities.requiresImage ?? runtime.type !== "local";
    const environmentSource = parsedInput.environmentSource
      || (parsedInput.imageSelection ? { type: "image" as const, imageSelection: parsedInput.imageSelection } : undefined)
      || (requiresImage && project?.defaultImageSelection ? { type: "image" as const, imageSelection: project.defaultImageSelection } : undefined);
    if (environmentSource?.type === "template" && runtime.type !== "docker") {
      throw publicError(`Runtime ${runtime.name} does not support environment templates.`, 409, "ENVIRONMENT_TEMPLATE_RUNTIME_UNSUPPORTED");
    }
    const imageSelection = environmentSource?.type === "image" ? environmentSource.imageSelection : undefined;
    const imageOption = imageSelection ? this.options.resolveImageSelection(imageSelection) : undefined;
    const environmentTemplate = environmentSource?.type === "template"
      ? await this.options.gateway.getEnvironmentTemplate(node, environmentSource.environmentTemplateId)
      : undefined;
    if (environmentTemplate && environmentTemplate.status !== "ready") {
      throw publicError(`Environment template ${environmentTemplate.id} is ${environmentTemplate.status}.`, 409, "ENVIRONMENT_TEMPLATE_NOT_READY");
    }
    if (environmentTemplate && environmentTemplate.nodeId !== node.id) {
      throw publicError(`Environment template ${environmentTemplate.id} belongs to node ${environmentTemplate.nodeId}.`, 409, "ENVIRONMENT_TEMPLATE_NODE_MISMATCH");
    }
    if (requiresImage && !imageOption && !environmentTemplate) {
      throw publicError(`Runtime ${runtime.name} requires an image.`, 400, "RUNTIME_IMAGE_REQUIRED");
    }

    const source = await this.resolveSource({
      node,
      runtime,
      project,
      source: parsedInput.source,
      sourceSnapshot: parsedInput.sourceSnapshot,
      imageOption,
    });
    const instanceId = parsedInput.id || createId("inst");
    const gitProvisioning = this.prepareGitProvisioning({
      instanceId,
      runtime,
      source: source.configured,
      retention: parsedInput.gitCredentialRetention,
      agentCapabilities,
    });
    const preparedModels = await this.options.prepareModels(node, parsedInput.modelSelection || {});
    const imageSnapshot = imageOption ? createImageSnapshot(imageOption) : undefined;
    const retainedPayload = gitProvisioning?.retention === "instance-retained"
      ? gitProvisioning.input.credentials[0].payload
      : undefined;
    let instance: ControlledInstance | undefined;
    let assigned: ControlledInstance | undefined;
    try {
      // Persist retained material before the node can race into image/workspace provisioning.
      if (retainedPayload) await this.options.gateway.deployGitCredential(node, retainedPayload);
      instance = await this.options.gateway.createInstance(node, {
        id: instanceId,
        name: parsedInput.name,
        runtimeId,
        ...(environmentSource ? { environmentSource } : {}),
        ...(imageOption && imageSnapshot ? {
          image: imageSnapshot,
        } : {}),
        projectId: project?.id,
        source: source.value,
        sourceSnapshot: source.snapshot,
        config: parsedInput.config,
        modelSelection: {},
        ...(gitProvisioning ? { gitWorkspaceProvisioning: gitProvisioning.input } : {}),
      });
      assigned = instance;
      if (gitProvisioning?.retention === "instance-retained") {
        const assignment = this.options.gitCredentials.authorize(instance.id, gitProvisioning.credentialId);
        await this.options.gateway.replaceGitCredentialAuthorizations(node, this.options.gitCredentials.desiredAuthorizationSet(instance.id));
        this.options.gitCredentials.markAssignmentStatus(
          instance.id,
          gitProvisioning.credentialId,
          "synced",
        );
      }
      assigned = (await this.options.gateway.assignInstanceModels(node, instance.id, preparedModels)).instance;
    } catch (error) {
      if (instance && gitProvisioning?.retention === "instance-retained") {
        this.options.gitCredentials.revoke(instance.id, gitProvisioning.credentialId);
      }
      if (instance) await this.options.gateway.deleteInstance(node, instance.id, { deleteVolumes: true }).catch(() => undefined);
      if (retainedPayload) await this.options.gateway.removeGitCredential(node, retainedPayload.credential.id).catch(() => undefined);
      throw error;
    }

    if (!assigned) throw publicError("Instance creation did not return an instance.", 502, "INSTANCE_CREATE_FAILED");

    let startOutcome: { status: "not-requested" | "started" | "failed"; error?: { code: string; message: string } } = {
      status: "not-requested",
    };
    if (parsedInput.start) {
      try {
        assigned = await this.options.gateway.startInstance(node, assigned.id);
        startOutcome = { status: "started" };
      } catch (error) {
        startOutcome = { status: "failed", error: publicOperationError(error, "INSTANCE_START_FAILED") };
        assigned = await this.options.gateway.listInstances(node)
          .then((instances) => instances.find((candidate) => candidate.id === assigned.id) || assigned)
          .catch(() => assigned);
      }
    }
    return {
      ...publicInstanceWithAccess(assigned),
      registrationToken: assigned.registrationToken,
      startOutcome,
    };
  }

  private prepareGitProvisioning(input: {
    instanceId: string;
    runtime: NodeRuntime;
    source: Project["source"];
    retention?: GitCredentialRetention;
    agentCapabilities: unknown;
  }): { credentialId: string; retention: GitCredentialRetention; input: GitWorkspaceProvisioningInput } | undefined {
    if (input.source.type === "local-folder") {
      if (input.retention) throw publicError("Git credential retention requires a Git source.", 400, "GIT_CREDENTIAL_SOURCE_REQUIRED");
      return undefined;
    }
    if (input.source.auth.type === "none") {
      if (input.retention) throw publicError("The Git Repository does not have a credential to retain.", 409, "GIT_REPOSITORY_CREDENTIAL_NOT_CONFIGURED");
      return undefined;
    }
    const credentialId = input.source.auth.secretId;
    if (!credentialId) throw publicError("The Git Repository credential reference is missing.", 409, "GIT_REPOSITORY_CREDENTIAL_REQUIRED");
    const retention = input.retention || "operation-only";
    if (!supportsNodeManagedGitCredentialRegistry(input.agentCapabilities) || !supportsNodeGitCredentialRuntimeBroker(input.agentCapabilities)) {
      throw publicError("The selected node does not support managed Git credentials.", 409, "GIT_CREDENTIAL_NODE_UNSUPPORTED");
    }
    if (!supportsNodeGitWorkspaceProvisioning(input.agentCapabilities, input.runtime.type)) {
      throw publicError(`Runtime ${input.runtime.name} does not support managed Git workspace provisioning.`, 409, "GIT_CREDENTIAL_PROVISIONING_UNSUPPORTED");
    }
    const payload = this.options.gitCredentials.payload(credentialId);
    if (payload.credential.kind !== input.source.auth.type) {
      throw publicError("The Git Repository auth type does not match its credential.", 409, "GIT_REPOSITORY_CREDENTIAL_KIND_MISMATCH");
    }
    const result = resolveGitCredential(input.source.url, [{
      id: payload.credential.id,
      kind: payload.credential.kind,
      scope: payload.credential.scope,
      status: payload.credential.status,
      pinnedKnownHosts: payload.secret.kind === "ssh-key" && Boolean(payload.secret.pinnedKnownHosts.trim()),
    }]);
    if (result.status !== "unique" || result.credential.id !== credentialId) {
      throw publicError(`The Git Repository credential does not uniquely authorize its remote (${result.status}).`, 409, `GIT_REPOSITORY_CREDENTIAL_${result.status.replace(/-/g, "_").toUpperCase()}`);
    }
    return {
      credentialId,
      retention,
      input: {
        operationId: createId("gitop"),
        instanceId: input.instanceId,
        remoteUrl: input.source.url,
        ref: input.source.ref,
        clone: input.source.clone,
        credentials: [{ operationId: createId("gitcredop"), retention, payload }],
      },
    };
  }

  private async resolveSource(input: {
    node: Node;
    runtime: NodeRuntime;
    project?: Project;
    source?: Project["source"];
    sourceSnapshot?: Record<string, unknown>;
    imageOption?: SelectableImage;
  }) {
    let source = input.source || input.project?.source;
    let snapshot: Record<string, unknown> = sourceSnapshotWithoutGitCredential(input.sourceSnapshot || (input.project ? {
      ...input.project,
      source: projectSourceWithoutGitCredential(input.project.source),
    } as unknown as Record<string, unknown> : {}));
    if (!source) throw publicError("Instance source is required.", 400, "INSTANCE_SOURCE_REQUIRED");
    if (input.runtime.type === "local" && source.type !== "local-folder") {
      throw publicError("Localhost runtime currently supports local folder sources only.", 400, "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER");
    }
    if (source.type !== "local-folder") return { value: projectSourceWithoutGitCredential(source), configured: source, snapshot };
    if (source.ownerNodeId && source.ownerNodeId !== input.node.id) {
      throw publicError(
        `Local folder ${source.path} belongs to node ${source.ownerNodeId}, not ${input.node.id}.`,
        400,
        "LOCAL_FOLDER_REQUIRES_OWNER_NODE",
      );
    }
    const folder = source.localFolderId
      ? await this.options.requireLocalFolder(input.node, source.localFolderId)
      : await this.options.gateway.createLocalFolder(input.node, {
          name: typeof snapshot.name === "string" ? snapshot.name : "Local folder",
          path: source.path,
          defaultImageSelection: input.imageOption
            ? { imageId: input.imageOption.id, tag: input.imageOption.tag }
            : undefined,
        });
    source = { ...source, localFolderId: folder.id, ownerNodeId: folder.nodeId, path: folder.path };
    snapshot = folder as unknown as Record<string, unknown>;
    return { value: source, configured: source, snapshot };
  }
}

function sourceSnapshotWithoutGitCredential(snapshot: Record<string, unknown>) {
  const parsedSource = ProjectSourceSchema.safeParse(snapshot.source);
  if (!parsedSource.success) return snapshot;
  return { ...snapshot, source: projectSourceWithoutGitCredential(parsedSource.data) };
}

function createImageSnapshot(image: SelectableImage) {
  const timestamp = now();
  return {
    id: image.id,
    origin: image.origin,
    name: image.name,
    description: image.description,
    localizedDescriptions: image.localizedDescriptions,
    cover: image.cover,
    repository: image.repository,
    tag: image.tag,
    requestedReference: image.reference,
    resolvedDigest: image.digest,
    resolvedReference: image.digest ? `${image.repository}@${image.digest}` : undefined,
    downloadSizeBytes: image.downloadSizeBytes,
    pullPolicy: "if-not-present" as const,
    capabilities: image.capabilities,
    optionalApps: image.optionalApps,
    defaultEnv: image.defaultEnv,
    labels: image.labels,
    market: image.market,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function publicOperationError(error: unknown, fallbackCode: string) {
  const source = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  return {
    code: typeof source.code === "string" && source.code.trim() ? source.code : fallbackCode,
    message: typeof source.message === "string" && source.message.trim() ? source.message : String(error),
  };
}

function publicError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}
