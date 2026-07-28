import {
  ImageProfileSchema,
  ProjectSchema,
  ProjectSourceSchema,
  WorkspacePolicySchema,
  type ImageProfile,
  type Project,
} from "@task-handoff/protocol/control-plane";
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

export type ControlPlaneCatalogServiceOptions = {
  projects: JsonCollection<Project>;
  images: JsonCollection<ImageProfile>;
  settings: JsonFile<ControlPlaneSettings>;
  defaultNodeId: () => string | undefined;
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
    const timestamp = now();
    const defaults = [
      {
        id: "img_default",
        name: "TaskHandoff Browser",
        reference: process.env.TASK_HANDOFF_CONTROLLED_BROWSER_IMAGE || "huadream/task-handoff-controlled-browser:latest",
        capabilities: ["browser", "terminal", "gui-terminal", "vscode-web", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal", "vscode-web"],
        labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": "browser" },
      },
      {
        id: "img_codex",
        name: "TaskHandoff Codex",
        reference: process.env.TASK_HANDOFF_CONTROLLED_CODEX_IMAGE || "huadream/task-handoff-controlled-codex:latest",
        capabilities: ["terminal", "codex"],
        optionalApps: ["terminal-tty"],
        labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": "codex" },
      },
      {
        id: "img_ai",
        name: "TaskHandoff Codex + Claude",
        reference: process.env.TASK_HANDOFF_CONTROLLED_AI_IMAGE || "huadream/task-handoff-controlled-ai:latest",
        capabilities: ["terminal", "codex", "claude"],
        optionalApps: ["terminal-tty"],
        labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": "ai" },
      },
    ];
    for (const image of defaults) {
      if (this.options.images.get(image.id)) continue;
      this.options.images.put(ImageProfileSchema.parse({
        ...image,
        pullPolicy: "if-not-present",
        defaultEnv: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
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
    const source = ProjectSourceSchema.parse(parsedInput.source);
    return this.options.projects.put(ProjectSchema.parse({
      ...parsedInput,
      id: parsedInput.id || createId("proj"),
      source,
      defaultImageId: parsedInput.defaultImageId || "img_default",
      defaultNodeId: parsedInput.defaultNodeId || this.options.defaultNodeId(),
      defaultRuntimeId: parsedInput.defaultRuntimeId || "runtime_local_docker",
      workspacePolicy: WorkspacePolicySchema.parse(parsedInput.workspacePolicy || workspacePolicyForSource(source)),
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  updateProject(id: string, input: unknown) {
    const parsedInput: UpdateProjectInput = UpdateProjectInputSchema.parse(input);
    const current = this.requireProject(id);
    const source = parsedInput.source ? ProjectSourceSchema.parse(parsedInput.source) : current.source;
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

  listImages() {
    return this.options.images.list();
  }

  createImage(input: unknown) {
    const parsedInput = CreateImageInputSchema.parse(input);
    const timestamp = now();
    return this.options.images.put(ImageProfileSchema.parse({
      ...parsedInput,
      id: parsedInput.id || createId("img"),
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
    return this.options.images.put(ImageProfileSchema.parse({
      ...current,
      ...parsedInput,
      id,
      createdAt: current.createdAt,
      updatedAt: now(),
    }));
  }

  deleteImage(id: string) {
    return this.options.images.delete(id);
  }

  requireImage(id: string) {
    const record = this.options.images.get(id);
    if (!record) throwNotFound("IMAGE_NOT_FOUND", `Image ${id} was not found.`);
    return record;
  }

  private normalizeProjectRecord(record: unknown) {
    const project = normalizeProject(record);
    if (project !== record) this.options.projects.put(project);
    return project;
  }
}
