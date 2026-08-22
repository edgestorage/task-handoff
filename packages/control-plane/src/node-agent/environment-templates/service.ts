import {
  EnvironmentTemplateSchema,
  type ControlledInstance,
  type EnvironmentTemplate,
  type NodeRuntime,
} from "@task-handoff/protocol/control-plane";
import { z } from "zod";
import { createId } from "../../shared/persistence/store.ts";
import type { LocalDockerExecutor } from "../runtimes/docker.ts";
import type { EnvironmentTemplateStore } from "./store.ts";
import type { InstancePrivateConfigStore } from "../instances/private-config-store.ts";
import { InstanceOperationGate } from "../instances/instance-operation-gate.ts";
import { nowIso as now } from "@task-handoff/core/core/time";

export const CreateEnvironmentTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
}).strict();

function operationError(error: unknown, fallbackCode: string, phase: NonNullable<EnvironmentTemplate["error"]>["phase"]) {
  return {
    code: typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    phase,
  };
}

export class EnvironmentTemplateService {
  private readonly templateOperations = new InstanceOperationGate();
  private readonly store: EnvironmentTemplateStore;
  private readonly privateConfigs: InstancePrivateConfigStore;
  private readonly docker: LocalDockerExecutor;
  private readonly requireInstanceValue: (id: string) => ControlledInstance;
  private readonly requireRuntimeValue: (id: string) => NodeRuntime;
  private readonly runInstanceOperationValue: <T>(instanceId: string, operation: () => Promise<T>) => Promise<T>;
  private readonly isImageReferencedValue: (imageId: string) => boolean;

  constructor(
    store: EnvironmentTemplateStore,
    privateConfigs: InstancePrivateConfigStore,
    docker: LocalDockerExecutor,
    requireInstance: (id: string) => ControlledInstance,
    requireRuntime: (id: string) => NodeRuntime,
    runInstanceOperation: <T>(instanceId: string, operation: () => Promise<T>) => Promise<T>,
    isImageReferenced: (imageId: string) => boolean = () => false,
  ) {
    this.store = store;
    this.privateConfigs = privateConfigs;
    this.docker = docker;
    this.requireInstanceValue = requireInstance;
    this.requireRuntimeValue = requireRuntime;
    this.runInstanceOperationValue = runInstanceOperation;
    this.isImageReferencedValue = isImageReferenced;
  }

  list() {
    return this.store.list();
  }

  require(id: string) {
    const template = this.store.get(id);
    if (!template) {
      throw Object.assign(new Error(`Environment template ${id} was not found.`), { statusCode: 404, code: "ENVIRONMENT_TEMPLATE_NOT_FOUND" });
    }
    return template;
  }

  runTemplateOperation<T>(id: string, operation: () => Promise<T> | T) {
    return this.templateOperations.run(id, async () => operation());
  }

  async create(sourceInstanceId: string, input: unknown) {
    const parsed = CreateEnvironmentTemplateInputSchema.parse(input);
    const source = this.requireInstanceValue(sourceInstanceId);
    const runtime = this.requireRuntimeValue(source.runtimeId);
    if (runtime.type !== "docker") {
      throw Object.assign(new Error(`Runtime ${runtime.name} does not support environment templates.`), {
        statusCode: 409,
        code: "ENVIRONMENT_TEMPLATE_RUNTIME_UNSUPPORTED",
      });
    }
    if (!source.runtime.containerName) {
      throw Object.assign(new Error(`Instance ${source.id} does not have a Docker container.`), {
        statusCode: 409,
        code: "ENVIRONMENT_TEMPLATE_CONTAINER_NOT_FOUND",
      });
    }
    const timestamp = now();
    const id = createId("envtpl");
    const internalTag = `task-handoff/environment-template:${id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
    this.store.put(EnvironmentTemplateSchema.parse({
      id,
      name: parsed.name,
      sourceInstanceId: source.id,
      nodeId: source.nodeId,
      internalTag,
      status: "creating",
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    return this.runInstanceOperationValue(source.id, async () => {
      let committed = false;
      let committedImageId: string | undefined;
      try {
        const authoritative = this.requireInstanceValue(source.id);
        if (this.requireRuntimeValue(authoritative.runtimeId).type !== "docker" || !authoritative.runtime.containerName) {
          throw Object.assign(new Error(`Instance ${source.id} is no longer a valid Docker template source.`), { code: "ENVIRONMENT_TEMPLATE_SOURCE_CHANGED" });
        }
        const privateConfig = this.privateConfigs.get(source.id);
        if (!privateConfig) {
          throw Object.assign(new Error(`Instance ${source.id} private configuration is missing.`), { code: "INSTANCE_PRIVATE_CONFIG_MISSING" });
        }
        const secretValues = [privateConfig.instanceCredential, ...Object.values(privateConfig.environment)];
        await this.docker.inspectContainerConfigSecurity(authoritative.runtime.containerName, secretValues);
        committedImageId = await this.docker.commitEnvironmentTemplate(authoritative.runtime.containerName, authoritative.runtime.containerId, internalTag);
        committed = true;
        const image = await this.docker.inspectEnvironmentTemplateImage(internalTag);
        await this.docker.inspectImageConfigSecurity(internalTag, secretValues);
        return this.store.put(EnvironmentTemplateSchema.parse({
          ...this.require(id),
          ...image,
          status: "ready",
          error: undefined,
          updatedAt: now(),
        }));
      } catch (error) {
        if (committed) {
          await this.docker.untagEnvironmentTemplate(internalTag, committedImageId).catch(() => false);
          if (committedImageId) await this.docker.garbageCollectEnvironmentTemplateImage(committedImageId).catch(() => false);
        }
        return this.store.put(EnvironmentTemplateSchema.parse({
          ...this.require(id),
          status: "failed",
          error: operationError(error, "ENVIRONMENT_TEMPLATE_CREATE_FAILED", "commit"),
          updatedAt: now(),
        }));
      }
    });
  }

  async delete(id: string) {
    return this.runTemplateOperation(id, async () => {
      const template = this.require(id);
      this.store.put(EnvironmentTemplateSchema.parse({ ...template, status: "deleting", error: undefined, updatedAt: now() }));
      try {
        const recoveredImageId = template.internalTag
          ? await this.docker.untagEnvironmentTemplate(template.internalTag, template.imageId)
          : undefined;
        const imageId = template.imageId || recoveredImageId;
        if (imageId && !this.isImageReferencedValue(imageId)) {
          await this.docker.garbageCollectEnvironmentTemplateImage(imageId);
        }
        this.store.delete(id);
        return { deleted: true, templateId: id };
      } catch (error) {
        this.store.put(EnvironmentTemplateSchema.parse({
          ...template,
          status: "failed",
          error: operationError(error, "ENVIRONMENT_TEMPLATE_DELETE_FAILED", "delete"),
          updatedAt: now(),
        }));
        throw error;
      }
    });
  }

  async releaseUnusedImage(imageId: string) {
    if (this.store.list().some((template) => template.imageId === imageId) || this.isImageReferencedValue(imageId)) return false;
    return this.docker.garbageCollectEnvironmentTemplateImage(imageId);
  }
}
