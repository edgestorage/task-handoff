import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import { ControlPlaneTriggersSchema, triggerConfigHash, type TriggerConfig } from "@task-handoff/protocol/triggers";
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

export type ControlPlaneTriggerServiceOptions = {
  triggers: JsonCollection<ControlPlaneTriggerRecord>;
  listInstances: () => Promise<ControlledInstance[]>;
  requireInstance: (instanceId: string) => Promise<ControlledInstance>;
  instanceRequest: (instance: ControlledInstance, route: string, init?: RequestInit) => Promise<unknown>;
};

export class ControlPlaneTriggerService {
  private readonly triggers: JsonCollection<ControlPlaneTriggerRecord>;
  private readonly listInstances: ControlPlaneTriggerServiceOptions["listInstances"];
  private readonly requireInstance: ControlPlaneTriggerServiceOptions["requireInstance"];
  private readonly instanceRequest: ControlPlaneTriggerServiceOptions["instanceRequest"];

  constructor(options: ControlPlaneTriggerServiceOptions) {
    this.triggers = options.triggers;
    this.listInstances = options.listInstances;
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

    const instances = await this.listInstances();
    const results = [];
    for (const instance of instances) {
      const item = instance.triggers?.configs?.find((entry) => entry.configHash === configHash);
      const deployments = (item?.deployments || []).filter((deployment) => deployment.origin === "control-plane");
      if (nextConfigHash === configHash) {
        if (deployments.length) {
          results.push({
            instanceId: instance.id,
            data: await this.instanceRequest(instance, `/triggers/${encodeURIComponent(configHash)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: record.name, description: record.description ?? null }),
            }),
          });
        }
        continue;
      }
      for (const deployment of deployments) {
        const deploymentId = deployment.target.type === "ai-session"
          ? aiSessionTriggerDeploymentId(deployment.target.aiSessionId, nextConfigHash)
          : deployment.deploymentId;
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
        results.push({ instanceId: instance.id, deploymentId, data });
      }
    }

    this.triggers.put(record);
    if (nextConfigHash !== configHash) this.triggers.delete(configHash);
    return { previousConfigHash: configHash, trigger: record, results };
  }

  async deleteTrigger(configHash: string) {
    const deletedTemplate = this.triggers.delete(configHash);
    const instances = await this.listInstances();
    const results = [];
    for (const instance of instances) {
      const item = instance.triggers?.configs?.find((entry) => entry.configHash === configHash);
      if (!item) {
        continue;
      }
      const controlPlaneDeployments = (item.deployments || []).filter((deployment) => deployment.origin === "control-plane");
      if (!controlPlaneDeployments.length) {
        continue;
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
            results.push({ instanceId: instance.id, configHash, deploymentId: deployment.deploymentId, deleted: false, skipped: "missing-deployment-id" });
            continue;
          }
          const data = await this.instanceRequest(instance, route, { method: "DELETE" });
          results.push({ instanceId: instance.id, configHash, deploymentId: deployment.deploymentId, deleted: true, data });
          if (!deployment.deploymentId) {
            break;
          }
        } catch (error) {
          results.push({
            instanceId: instance.id,
            configHash,
            deploymentId: deployment.deploymentId,
            deleted: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (!deletedTemplate && !results.length) {
      throwNotFound("TRIGGER_NOT_FOUND", `Trigger ${configHash} was not found.`);
    }
    return { configHash, deletedTemplate, results };
  }

  async applyTrigger(configHash: string, input: unknown) {
    const config = this.requireTrigger(configHash);
    const parsed = ApplyControlPlaneTriggerSchema.parse(input || {});
    const results = [];
    for (const instanceId of parsed.instanceIds) {
      const instance = await this.requireInstance(instanceId);
      results.push({
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
      });
    }
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
    return this.instanceRequest(instance, "/triggers", {
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
    });
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

function aiSessionTriggerDeploymentId(sessionId: string, configHash: string) {
  return `ai_${Buffer.from(sessionId).toString("base64url")}_${configHash}`;
}
