import {
  CustomImageProfileSchema,
  DEFAULT_IMAGE_COVER,
  SelectableImageSchema,
  ProjectSchema,
  ProjectSourceSchema,
  WorkspacePolicySchema,
  parseDockerImageReference,
  type CustomImageProfile,
  type ImageSelection,
  type MarketImage,
  type Project,
  type SelectableImage,
} from "@task-handoff/protocol/control-plane";
import { resolveGitCredential, type GitCredentialPublic } from "@task-handoff/protocol/managed-git-credentials";
import { createId, type JsonCollection, type JsonFile } from "../../shared/persistence/store.ts";
import {
  CreateImageInputSchema,
  CreateProjectInputSchema,
  ControlPlaneSettingsSchema,
  UpdateControlPlaneSettingsSchema,
  UpdateImageInputSchema,
  UpdateProjectInputSchema,
  type UpdateImageInput,
  type UpdateProjectInput,
  type ControlPlaneSettings,
} from "./inputs.ts";
import { now, throwNotFound } from "../common/helpers.ts";
import { normalizeProject, workspacePolicyForSource } from "../public-records.ts";
import { MarketCatalogService } from "./market.ts";

export type ControlPlaneCatalogServiceOptions = {
  projects: JsonCollection<Project>;
  images: JsonCollection<CustomImageProfile>;
  market: MarketCatalogService;
  settings: JsonFile<ControlPlaneSettings>;
  defaultNodeId: () => string | undefined;
  requireGitCredential: (id: string) => GitCredentialPublic;
};

export class ControlPlaneCatalogService {
  private readonly options: ControlPlaneCatalogServiceOptions;

  constructor(options: ControlPlaneCatalogServiceOptions) {
    this.options = options;
  }

  getSettings() {
    return ControlPlaneSettingsSchema.parse(this.options.settings.get());
  }

  updateSettings(input: unknown) {
    const parsed = UpdateControlPlaneSettingsSchema.parse(input);
    const next = ControlPlaneSettingsSchema.parse({
      ...this.getSettings(),
      ...parsed,
      ...("publicBaseUrl" in parsed ? { publicBaseUrl: parsed.publicBaseUrl?.trim() || undefined } : {}),
    });
    return this.options.settings.put(next);
  }

  seedDefaults() {
    // Embedded Market images are owned by MarketCatalogService and never
    // persisted in the user-managed Custom Image collection.
  }

  listProjects() {
    return this.options.projects.list().map((project) => this.normalizeProjectRecord(project));
  }

  getProject(id: string) {
    const record = this.options.projects.get(id);
    return record ? this.normalizeProjectRecord(record) : undefined;
  }

  createProject(input: unknown) {
    const parsedInput = CreateProjectInputSchema.parse(input);
    const timestamp = now();
    const source = this.validateProjectSource(parsedInput.source);
    return this.options.projects.put(ProjectSchema.parse({
      ...parsedInput,
      id: parsedInput.id || createId("proj"),
      source,
      defaultImageSelection: parsedInput.defaultImageSelection || { imageId: "market_taskhandoff_browser" },
      defaultNodeId: parsedInput.defaultNodeId || this.options.defaultNodeId(),
      workspacePolicy: WorkspacePolicySchema.parse(parsedInput.workspacePolicy || workspacePolicyForSource(source)),
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  updateProject(id: string, input: unknown) {
    const parsedInput: UpdateProjectInput = UpdateProjectInputSchema.parse(input);
    const current = this.requireProject(id);
    const source = parsedInput.source ? this.validateProjectSource(parsedInput.source) : current.source;
    return this.options.projects.put(ProjectSchema.parse({
      ...current,
      ...parsedInput,
      id,
      source,
      workspacePolicy: parsedInput.workspacePolicy ? WorkspacePolicySchema.parse(parsedInput.workspacePolicy) : current.workspacePolicy,
      createdAt: current.createdAt,
      updatedAt: now(),
    }));
  }

  deleteProject(id: string) {
    return this.options.projects.delete(id);
  }

  requireProject(id: string) {
    const record = this.getProject(id);
    if (!record) throwNotFound("PROJECT_NOT_FOUND", `Project ${id} was not found.`);
    return record;
  }

  private validateProjectSource(input: unknown) {
    const source = ProjectSourceSchema.parse(input);
    if (source.type === "local-folder") return source;
    if (source.auth.type === "none") {
      if (source.auth.secretId) throw catalogGitCredentialError("A public Git repository cannot reference a credential.", "GIT_REPOSITORY_AUTH_INVALID");
      return source;
    }
    if (!source.auth.secretId) throw catalogGitCredentialError("Git repository authentication requires a credential.", "GIT_REPOSITORY_CREDENTIAL_REQUIRED");
    const credential = this.options.requireGitCredential(source.auth.secretId);
    if (credential.status !== "enabled") throw catalogGitCredentialError("The Git repository credential is disabled.", "GIT_REPOSITORY_CREDENTIAL_DISABLED");
    if (credential.kind !== source.auth.type) throw catalogGitCredentialError("Git repository auth type does not match its credential.", "GIT_REPOSITORY_CREDENTIAL_KIND_MISMATCH");
    const match = resolveGitCredential(source.url, [{ ...credential, status: "enabled" }]);
    if (match.status !== "unique" || match.credential.id !== credential.id) {
      throw catalogGitCredentialError(`Git repository credential does not authorize its remote (${match.status}).`, `GIT_REPOSITORY_CREDENTIAL_${match.status.replace(/-/g, "_").toUpperCase()}`);
    }
    return source;
  }

  listImages() {
    return this.options.images.list();
  }

  getMarketCatalog() {
    return { catalog: this.options.market.getCatalog(), status: this.options.market.getStatus() };
  }

  listImageOptions(platform?: { os?: string; architecture?: string }) {
    const market = this.options.market.getCatalog();
    return [
      ...market.items.map((image) => this.marketImageOption(image, undefined, platform, true)),
      ...this.listImages().map((image) => this.customImageOption(image)),
    ];
  }

  resolveImageSelection(selection: ImageSelection, platform?: { os?: string; architecture?: string }): SelectableImage {
    const marketImage = this.options.market.getCatalog().items.find((image) => image.id === selection.imageId);
    if (marketImage) return this.marketImageOption(marketImage, selection.tag, platform);
    const custom = this.options.images.get(selection.imageId);
    if (!custom) throwNotFound("IMAGE_NOT_FOUND", `Image ${selection.imageId} was not found.`);
    if (selection.tag && selection.tag !== custom.tag) {
      throw Object.assign(new Error(`Custom image ${custom.id} cannot override its stored tag.`), { statusCode: 400, code: "CUSTOM_IMAGE_TAG_OVERRIDE" });
    }
    return this.customImageOption(custom);
  }

  createImage(input: unknown) {
    const parsedInput = CreateImageInputSchema.parse(input);
    const timestamp = now();
    const reference = parseDockerImageReference(parsedInput.reference);
    return this.options.images.put(CustomImageProfileSchema.parse({
      ...parsedInput,
      id: parsedInput.id || createId("img"),
      origin: "custom",
      reference: reference.reference,
      repository: reference.repository,
      tag: reference.tag,
      pullPolicy: parsedInput.pullPolicy || "if-not-present",
      capabilities: parsedInput.capabilities || [],
      optionalApps: parsedInput.optionalApps || [],
      defaultEnv: parsedInput.defaultEnv || {},
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  updateImage(id: string, input: unknown) {
    const parsedInput: UpdateImageInput = UpdateImageInputSchema.parse(input);
    const current = this.requireImage(id);
    const reference = parseDockerImageReference(parsedInput.reference || current.reference);
    return this.options.images.put(CustomImageProfileSchema.parse({
      ...current,
      ...parsedInput,
      id,
      origin: "custom",
      reference: reference.reference,
      repository: reference.repository,
      tag: reference.tag,
      createdAt: current.createdAt,
      updatedAt: now(),
    }));
  }

  deleteImage(id: string) {
    return this.options.images.delete(id);
  }

  requireImage(id: string) {
    if (this.options.market.getCatalog().items.some((image) => image.id === id)) {
      throw Object.assign(new Error(`Market image ${id} is read-only.`), { statusCode: 403, code: "MARKET_IMAGE_READ_ONLY" });
    }
    const record = this.options.images.get(id);
    if (!record) throwNotFound("IMAGE_NOT_FOUND", `Image ${id} was not found.`);
    return record;
  }

  private normalizeProjectRecord(record: unknown) {
    const project = normalizeProject(record);
    if (project !== record) this.options.projects.put(project);
    return project;
  }

  private customImageOption(image: CustomImageProfile): SelectableImage {
    return SelectableImageSchema.parse({
      id: image.id,
      origin: "custom",
      name: image.name,
      description: image.description,
      localizedDescriptions: image.localizedDescriptions,
      cover: image.cover || DEFAULT_IMAGE_COVER,
      repository: image.repository,
      tag: image.tag,
      availableTags: image.tag ? [{ name: image.tag, reference: image.reference, status: "active" }] : [],
      reference: image.reference,
      capabilities: image.capabilities,
      optionalApps: image.optionalApps,
      defaultEnv: image.defaultEnv,
      labels: image.labels,
      readOnly: false,
    });
  }

  private marketImageOption(image: MarketImage, requestedTag?: string, platform?: { os?: string; architecture?: string }, includeYanked = false): SelectableImage {
    if (image.status === "yanked" && !includeYanked) {
      throw Object.assign(new Error(`Market image ${image.id} is no longer selectable.`), { statusCode: 409, code: "MARKET_IMAGE_YANKED" });
    }
    const tagName = requestedTag || image.defaultTag;
    const tag = image.tags.find((candidate) => candidate.name === tagName);
    if (!tag) throw Object.assign(new Error(`Market image ${image.id} does not provide tag ${tagName}.`), { statusCode: 400, code: "MARKET_IMAGE_TAG_NOT_FOUND" });
    if (tag.status === "yanked" && !includeYanked) throw Object.assign(new Error(`Market image tag ${image.id}:${tagName} is no longer selectable.`), { statusCode: 409, code: "MARKET_IMAGE_TAG_YANKED" });
    const artifact = tag.platforms.find((candidate) =>
      (!platform?.os || candidate.os === platform.os) && (!platform?.architecture || candidate.architecture === platform.architecture));
    const catalog = this.options.market.getCatalog();
    return SelectableImageSchema.parse({
      id: image.id,
      origin: "market",
      name: image.name,
      description: image.description,
      localizedDescriptions: image.localizedDescriptions,
      cover: image.cover || DEFAULT_IMAGE_COVER,
      repository: image.repository,
      tag: tag.name,
      availableTags: image.tags.map((candidate) => ({
        name: candidate.name,
        version: candidate.version,
        reference: candidate.reference,
        manifestDigest: candidate.manifestDigest,
        status: candidate.status,
      })),
      reference: tag.reference,
      digest: artifact?.digest || tag.manifestDigest,
      downloadSizeBytes: artifact?.downloadSizeBytes,
      unpackedSizeBytes: artifact?.unpackedSizeBytes,
      capabilities: image.capabilities,
      optionalApps: image.optionalApps,
      defaultEnv: image.defaultEnv,
      labels: image.labels,
      readOnly: true,
      lifecycleStatus: tag.status === "yanked" || image.status === "yanked"
        ? "yanked"
        : tag.status === "deprecated" || image.status === "deprecated" ? "deprecated" : "active",
      market: {
        catalogId: catalog.catalogId,
        catalogRevision: catalog.revision,
        publisher: image.publisher,
        version: tag.version,
      },
    });
  }
}

function catalogGitCredentialError(message: string, code: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
