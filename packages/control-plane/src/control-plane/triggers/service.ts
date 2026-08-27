import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import {
  ControlPlaneTriggersSchema,
  TriggerMutationResultSchema,
  triggerConfigHash,
  type ControlPlaneTriggerMutationFailure,
  type TriggerConfig,
} from "@task-handoff/protocol/triggers";
import type { JsonCollection } from "../../shared/persistence/store.ts";
import {
  ApplyControlPlaneTriggerSchema,
  BindAiSessionTriggerSchema,
  ControlPlaneTriggerRecordSchema,
  CreateControlPlaneTriggerSchema,
  UpdateControlPlaneTriggerSchema,
  type ControlPlaneTriggerRecord,
} from "./inputs.ts";
import { now, throwNotFound } from "../common/helpers.ts";

const TRIGGER_FANOUT_CONCURRENCY = 8;

type ControlPlaneTriggerMutationDirectory = {
  items: ControlledInstance[];
  partialFailures: ControlPlaneTriggerMutationFailure[];
};

export type ControlPlaneTriggerServiceOptions = {
  triggers: JsonCollection<ControlPlaneTriggerRecord>;
  listInstances: () => Promise<ControlledInstance[]>;
  listMutationInstances?: () => Promise<ControlPlaneTriggerMutationDirectory>;
  requireInstance: (instanceId: string) => Promise<ControlledInstance>;
  instanceRequest: (instance: ControlledInstance, route: string, init?: RequestInit) => Promise<unknown>;
};

export class ControlPlaneTriggerService {
  private readonly triggers: JsonCollection<ControlPlaneTriggerRecord>;
  private readonly listInstances: ControlPlaneTriggerServiceOptions["listInstances"];
  private readonly listMutationInstances: NonNullable<ControlPlaneTriggerServiceOptions["listMutationInstances"]>;
  private readonly requireInstance: ControlPlaneTriggerServiceOptions["requireInstance"];
  private readonly instanceRequest: ControlPlaneTriggerServiceOptions["instanceRequest"];

  constructor(options: ControlPlaneTriggerServiceOptions) {
    this.triggers = options.triggers;
    this.listInstances = options.listInstances;
    this.listMutationInstances = options.listMutationInstances
      ?? (async () => ({ items: await options.listInstances(), partialFailures: [] }));
    this.requireInstance = options.requireInstance;
    this.instanceRequest = options.instanceRequest;
  }

  async listTriggers() {
    const instances = await this.listInstances();
    const groups = new Map<string, {
      configHash: string;
      config: unknown;
      deploymentCount: number;
      enabledCount: number;
      runningCount: number;
      errorCount: number;
      ownedByControlPlane: boolean;
      controlPlaneDeploymentCount: number;
      deployments: unknown[];
      recentRuns: unknown[];
    }>();
    for (const record of this.triggers.list()) {
      groups.set(record.configHash, {
        configHash: record.configHash,
        config: publicTriggerConfig(record),
        deploymentCount: 0,
        enabledCount: 0,
        runningCount: 0,
        errorCount: 0,
        ownedByControlPlane: true,
        controlPlaneDeploymentCount: 0,
        deployments: [],
        recentRuns: [],
      });
    }
    for (const instance of instances) {
      const triggerState = instance.triggers;
      for (const item of triggerState?.configs || []) {
        const current = groups.get(item.configHash) || {
          configHash: item.configHash,
          config: item.config,
          deploymentCount: 0,
          enabledCount: 0,
          runningCount: 0,
          errorCount: 0,
          ownedByControlPlane: false,
          controlPlaneDeploymentCount: 0,
          deployments: [],
          recentRuns: [],
        };
        const deployments = (item.deployments || []).map((deployment) => ({
          instanceId: instance.id,
          instanceName: instance.name,
          deployment,
          runtime: (item.runtime || []).find((runtime) => runtime.deploymentId
            ? runtime.deploymentId === deployment.deploymentId
            : runtime.configHash === deployment.configHash),
        }));
        current.deploymentCount += deployments.length;
        current.enabledCount += deployments.filter((entry) => Boolean((entry.deployment as { enabled?: boolean }).enabled)).length;
        current.controlPlaneDeploymentCount += deployments.filter((entry) => (entry.deployment as { origin?: string }).origin === "control-plane").length;
        current.runningCount += (item.runtime || []).filter((runtime) => runtime.status === "running").length;
        current.errorCount += (item.runtime || []).filter((runtime) => runtime.status === "error").length;
        current.deployments.push(...deployments);
        current.recentRuns.push(...(triggerState.recentRuns || []).filter((run) => run.configHash === item.configHash).map((run) => ({ ...run, instanceId: instance.id, instanceName: instance.name })));
        groups.set(item.configHash, current);
      }
    }
    return ControlPlaneTriggersSchema.parse({
      updatedAt: new Date().toISOString(),
      triggers: [...groups.values()].sort((a, b) => String((a.config as { name?: string }).name || a.configHash).localeCompare(String((b.config as { name?: string }).name || b.configHash))),
    });
  }

  createTrigger(input: unknown) {
    const parsed = CreateControlPlaneTriggerSchema.parse(input || {});
    const timestamp = now();
    const policy = {
      maxConcurrentRuns: parsed.policy?.maxConcurrentRuns ?? 1,
      whenBusy: parsed.policy?.whenBusy ?? "skip",
      cooldownMs: parsed.policy?.cooldownMs,
    } as TriggerConfig["policy"];
    const configHash = triggerConfigHash({ source: parsed.source, action: parsed.action, policy });
    const record = ControlPlaneTriggerRecordSchema.parse({
      id: configHash,
      configHash,
      name: parsed.name,
      description: parsed.description,
      source: parsed.source,
      action: parsed.action,
      policy,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.triggers.put(record);
  }

  async updateTrigger(configHash: string, input: unknown) {
    const existing = this.requireTrigger(configHash);
    const parsed = UpdateControlPlaneTriggerSchema.parse(input || {});
    const timestamp = now();
    const policy = {
      maxConcurrentRuns: parsed.policy?.maxConcurrentRuns ?? 1,
      whenBusy: parsed.policy?.whenBusy ?? "skip",
      cooldownMs: parsed.policy?.cooldownMs,
    } as TriggerConfig["policy"];
    const nextConfigHash = triggerConfigHash({ source: parsed.source, action: parsed.action, policy });
    const collision = nextConfigHash !== configHash && this.triggers.get(nextConfigHash);
    if (collision) {
      const error = new Error(`Trigger ${nextConfigHash} already exists.`);
      Object.assign(error, { statusCode: 409, code: "TRIGGER_ALREADY_EXISTS" });
      throw error;
    }
    const record = ControlPlaneTriggerRecordSchema.parse({
      id: nextConfigHash,
      configHash: nextConfigHash,
      name: parsed.name,
      description: parsed.description,
      source: parsed.source,
      action: parsed.action,
      policy,
      createdAt: existing.createdAt,
      updatedAt: timestamp,
    });

    const directory = await this.listMutationInstances();
    const mutations = await mapConcurrent(directory.items, TRIGGER_FANOUT_CONCURRENCY, async (instance) => {
      const instanceResults = [];
      const partialFailures: ControlPlaneTriggerMutationFailure[] = [];
      const item = instance.triggers?.configs?.find((entry) => entry.configHash === configHash);
      const deployments = (item?.deployments || []).filter((deployment) => deployment.origin === "control-plane");
      if (nextConfigHash === configHash) {
        if (deployments.length) {
          try {
            const data = await this.instanceRequest(instance, `/triggers/${encodeURIComponent(configHash)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: record.name, description: record.description ?? null }),
            });
            instanceResults.push({ instanceId: instance.id, data });
          } catch (error) {
            partialFailures.push(triggerInstanceMutationFailure(instance, error));
          }
        }
        return { results: instanceResults, partialFailures };
      }
      for (const deployment of deployments) {
        const deploymentId = deployment.target.type === "ai-session"
          ? aiSessionTriggerDeploymentId(deployment.target.aiSessionId, nextConfigHash)
          : deployment.deploymentId;
        try {
          const data = await this.instanceRequest(instance, "/triggers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: record.name,
              description: record.description,
              source: record.source,
              action: record.action,
              policy: record.policy,
              deployment: {
                deploymentId,
                origin: "control-plane",
                enabled: deployment.enabled,
                target: deployment.target,
                localName: deployment.localName,
              },
            }),
          });
          const oldDeploymentId = deployment.deploymentId || deployment.configHash;
          await this.instanceRequest(instance, `/triggers/${encodeURIComponent(configHash)}/deployments/${encodeURIComponent(oldDeploymentId)}`, { method: "DELETE" });
          instanceResults.push({ instanceId: instance.id, deploymentId, data });
        } catch (error) {
          partialFailures.push(triggerInstanceMutationFailure(instance, error));
        }
      }
      return { results: instanceResults, partialFailures };
    });
    const results = mutations.flatMap((entry) => entry.results);
    const partialFailures = [...directory.partialFailures, ...mutations.flatMap((entry) => entry.partialFailures)];

    this.triggers.put(record);
    if (nextConfigHash !== configHash) this.triggers.delete(configHash);
    return { previousConfigHash: configHash, trigger: record, results, partialFailures };
  }

  async deleteTrigger(configHash: string) {
    const directory = await this.listMutationInstances();
    const deletedTemplate = this.triggers.delete(configHash);
    const mutations = await mapConcurrent(directory.items, TRIGGER_FANOUT_CONCURRENCY, async (instance) => {
      const instanceResults = [];
      const partialFailures: ControlPlaneTriggerMutationFailure[] = [];
      const item = instance.triggers?.configs?.find((entry) => entry.configHash === configHash);
      if (!item) {
        return { results: instanceResults, partialFailures };
      }
      const controlPlaneDeployments = (item.deployments || []).filter((deployment) => deployment.origin === "control-plane");
      if (!controlPlaneDeployments.length) {
        return { results: instanceResults, partialFailures };
      }
      const canDeleteWholeConfig = item.deployments.every((deployment) => deployment.origin === "control-plane");
      for (const deployment of controlPlaneDeployments) {
        try {
          const route = deployment.deploymentId
            ? `/triggers/${encodeURIComponent(configHash)}/deployments/${encodeURIComponent(deployment.deploymentId)}`
            : canDeleteWholeConfig
              ? `/triggers/${encodeURIComponent(configHash)}`
              : undefined;
          if (!route) {
            instanceResults.push({ instanceId: instance.id, configHash, deploymentId: deployment.deploymentId, deleted: false, skipped: "missing-deployment-id" });
            partialFailures.push({
              scope: "instance",
              nodeId: instance.nodeId,
              instanceId: instance.id,
              code: "TRIGGER_DEPLOYMENT_ID_MISSING",
              message: `Trigger deployment on instance ${instance.name} has no deletable deployment id.`,
            });
            continue;
          }
          const data = await this.instanceRequest(instance, route, { method: "DELETE" });
          instanceResults.push({ instanceId: instance.id, configHash, deploymentId: deployment.deploymentId, deleted: true, data });
          if (!deployment.deploymentId) {
            break;
          }
        } catch (error) {
          partialFailures.push(triggerInstanceMutationFailure(instance, error));
          instanceResults.push({
            instanceId: instance.id,
            configHash,
            deploymentId: deployment.deploymentId,
            deleted: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { results: instanceResults, partialFailures };
    });
    const results = mutations.flatMap((entry) => entry.results);
    const partialFailures = [...directory.partialFailures, ...mutations.flatMap((entry) => entry.partialFailures)];
    if (!deletedTemplate && !results.length) {
      throwNotFound("TRIGGER_NOT_FOUND", `Trigger ${configHash} was not found.`);
    }
    return { configHash, deletedTemplate, results, partialFailures };
  }

  async applyTrigger(configHash: string, input: unknown) {
    const config = this.requireTrigger(configHash);
    const parsed = ApplyControlPlaneTriggerSchema.parse(input || {});
    const results = await mapConcurrent(parsed.instanceIds, TRIGGER_FANOUT_CONCURRENCY, async (instanceId) => {
      const instance = await this.requireInstance(instanceId);
      return {
        instanceId,
        data: await this.instanceRequest(instance, "/triggers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: config.name,
            description: config.description,
            source: config.source,
            action: config.action,
            policy: config.policy,
            deployment: {
              origin: "control-plane",
              enabled: parsed.enabled ?? true,
              target: parsed.target,
            },
          }),
        }),
      };
    });
    return { configHash, results };
  }

  async listInstanceTriggers(instanceId: string) {
    const instance = await this.requireInstance(instanceId);
    return this.instanceRequest(instance, "/triggers");
  }

  async bindAiSessionTrigger(instanceId: string, sessionId: string, input: unknown) {
    const parsed = BindAiSessionTriggerSchema.parse(input || {});
    const config = this.requireTrigger(parsed.configHash);
    const instance = await this.requireInstance(instanceId);
    return TriggerMutationResultSchema.parse(await this.instanceRequest(instance, "/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: config.name,
        description: config.description,
        source: config.source,
        action: config.action,
        policy: config.policy,
        deployment: {
          deploymentId: aiSessionTriggerDeploymentId(sessionId, parsed.configHash),
          origin: "control-plane",
          enabled: parsed.enabled ?? true,
          target: { type: "ai-session", aiSessionId: sessionId },
        },
      }),
    }));
  }

  async unbindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
    const instance = await this.requireInstance(instanceId);
    const deploymentId = aiSessionTriggerDeploymentId(sessionId, configHash);
    return this.instanceRequest(instance, `/triggers/${encodeURIComponent(configHash)}/deployments/${encodeURIComponent(deploymentId)}`, {
      method: "DELETE",
    });
  }

  async runInstanceTrigger(instanceId: string, configHash: string, body: unknown = {}) {
    const instance = await this.requireInstance(instanceId);
    return this.instanceRequest(instance, `/triggers/${encodeURIComponent(configHash)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  private requireTrigger(configHash: string) {
    const config = this.triggers.get(configHash);
    if (!config) {
      throwNotFound("TRIGGER_NOT_FOUND", `Trigger ${configHash} was not found.`);
    }
    return config;
  }
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const run = async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (failed) throw failure;
  return results;
}

function publicTriggerConfig(record: ControlPlaneTriggerRecord): TriggerConfig {
  return {
    configHash: record.configHash,
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
    source: record.source,
    action: record.action,
    policy: record.policy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function triggerInstanceMutationFailure(
  instance: ControlledInstance,
  error: unknown,
): ControlPlaneTriggerMutationFailure {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const code = typeof record?.code === "string" && record.code ? record.code : "TRIGGER_INSTANCE_MUTATION_FAILED";
  const message = typeof record?.message === "string" && record.message ? record.message : String(error);
  return {
    scope: "instance",
    nodeId: instance.nodeId,
    instanceId: instance.id,
    code: code.slice(0, 160),
    message: message.slice(0, 4000),
  };
}

function aiSessionTriggerDeploymentId(sessionId: string, configHash: string) {
  return `ai_${Buffer.from(sessionId).toString("base64url")}_${configHash}`;
}
