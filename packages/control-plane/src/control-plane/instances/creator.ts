import type {
  Node,
  NodeLocalFolder,
  NodeRuntime,
  Project,
  SelectableImage,
} from "@task-handoff/protocol/control-plane";
import { CreateInstanceInputSchema } from "../application/inputs.ts";
import type { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { now } from "../application/helpers.ts";
import { publicInstanceWithAccess } from "../public-records.ts";

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
    selection: { codexModelHash?: string | null; claudeModelHash?: string | null },
  ) => Promise<unknown>;
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
    const preparedModels = await this.options.prepareModels(node, parsedInput.modelSelection || {});
    const imageSnapshot = imageOption ? createImageSnapshot(imageOption) : undefined;
    const instance = await this.options.gateway.createInstance(node, {
      id: parsedInput.id,
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
    });

    let assigned = instance;
    try {
      assigned = (await this.options.gateway.assignInstanceModels(node, instance.id, preparedModels)).instance;
    } catch (error) {
      await this.options.gateway.deleteInstance(node, instance.id, { deleteVolumes: true }).catch(() => undefined);
      throw error;
    }

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

  private async resolveSource(input: {
    node: Node;
    runtime: NodeRuntime;
    project?: Project;
    source?: Project["source"];
    sourceSnapshot?: Record<string, unknown>;
    imageOption?: SelectableImage;
  }) {
    let source = input.source || input.project?.source;
    let snapshot: Record<string, unknown> = input.sourceSnapshot || (input.project ? input.project as unknown as Record<string, unknown> : {});
    if (!source) throw publicError("Instance source is required.", 400, "INSTANCE_SOURCE_REQUIRED");
    if (input.runtime.type === "local" && source.type !== "local-folder") {
      throw publicError("Localhost runtime currently supports local folder sources only.", 400, "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER");
    }
    if (source.type !== "local-folder") return { value: source, snapshot };
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
    return { value: source, snapshot };
  }
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
