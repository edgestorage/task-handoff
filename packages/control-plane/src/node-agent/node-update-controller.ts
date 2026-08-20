import type { FastifyInstance } from "fastify";
import {
  ApplyUpdateRequestSchema,
  UpdateCheckRequestSchema,
  type ControlledInstance,
  type RuntimeArtifactIdentity,
  type UpdateCheckResult,
} from "@task-handoff/protocol/control-plane";
import { createSecret } from "../shared/persistence/store.ts";
import type { CommandRunner } from "./runtimes/docker.ts";
import {
  checkNodeAgentUpdate,
  npmCommand,
  resolveNodeAgentUpdateWorker,
  resolveNodeUpdatePackage,
  type NodeUpdateJobs,
} from "./updates.ts";

const UPDATE_PREFLIGHT_TTL_MS = 10 * 60 * 1_000;
const NodeAgentApplyUpdateRequestSchema = ApplyUpdateRequestSchema.strict();

type Options = {
  nodeId: string;
  jobs: NodeUpdateJobs;
  runCommand: CommandRunner;
  currentRuntimeVersion(): string;
  listInstances(): ControlledInstance[];
  resolveRuntimeArtifacts(version: string): Promise<RuntimeArtifactIdentity[]>;
  moduleDir: string;
};

function updateImpact(instances: ControlledInstance[]): UpdateCheckResult["impact"] {
  const running = instances.filter((instance) => !["created", "stopped", "failed"].includes(instance.status));
  const runningIds = new Set(running.map((instance) => instance.id));
  const active = running.filter((instance) => instance.apps.runningCount > 0 || instance.aiSessions.runningCount > 0);
  return {
    runningInstanceCount: running.length,
    stoppedInstanceCount: instances.length - running.length,
    activeInstanceCount: active.length,
    restartInstanceCount: running.length,
    runningInstanceIds: running.map((instance) => instance.id).sort(),
    stoppedInstanceIds: instances.filter((instance) => !runningIds.has(instance.id)).map((instance) => instance.id).sort(),
    activeInstanceIds: active.map((instance) => instance.id).sort(),
  };
}

export class NodeUpdateController {
  private readonly preflights = new Map<string, { result: UpdateCheckResult; expiresAt: number }>();
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  async check(input: unknown) {
    const parsed = UpdateCheckRequestSchema.parse(input);
    const impact = updateImpact(this.options.listInstances());
    const selection = await resolveNodeUpdatePackage(this.options.runCommand, this.options.moduleDir);
    const currentRuntimeVersion = this.options.currentRuntimeVersion();
    const relatedCurrentVersions = selection.packageName === "@task-handoff/server"
      ? [...new Set([...selection.relatedCurrentVersions, currentRuntimeVersion])]
      : selection.relatedCurrentVersions;
    const check = await checkNodeAgentUpdate({
      channel: parsed.channel,
      currentVersion: selection.currentVersion || currentRuntimeVersion,
      runCommand: this.options.runCommand,
      packageName: selection.packageName,
      relatedCurrentVersions,
      impact,
    });
    if (!check.updateAvailable) return check;
    const result: UpdateCheckResult = {
      ...check,
      runtimeArtifacts: await this.options.resolveRuntimeArtifacts(check.availableVersion),
      preflightToken: createSecret(),
    };
    this.preflights.set(result.preflightToken!, {
      result,
      expiresAt: Date.now() + UPDATE_PREFLIGHT_TTL_MS,
    });
    return result;
  }

  async apply(input: unknown) {
    const parsed = NodeAgentApplyUpdateRequestSchema.parse(input);
    const check = await this.consumePreflight(parsed);
    if (!check.supported) {
      throw Object.assign(new Error(check.reason || "The requested update is not supported."), {
        statusCode: 400,
        code: "UPDATE_UNSUPPORTED",
      });
    }
    if (!check.updateAvailable) {
      throw Object.assign(new Error(check.reason || "No update is available for the selected channel."), {
        statusCode: 409,
        code: "UPDATE_NOT_AVAILABLE",
      });
    }
    const job = this.options.jobs.create(this.options.nodeId, check);
    const { worker, packaged, expectedWorker } = resolveNodeAgentUpdateWorker(this.options.moduleDir);
    if (!worker) {
      this.options.jobs.patch(job.id, {
        status: "failed",
        rollout: { ...job.rollout, phase: "failed" },
        error: { code: "NODE_UPDATE_FAILED", message: `Update worker was not found: ${expectedWorker}`, retryable: false },
        completedAt: new Date().toISOString(),
      });
      throw Object.assign(new Error(`Node agent update worker was not found: ${expectedWorker}`), {
        statusCode: 500,
        code: "UPDATE_WORKER_NOT_FOUND",
      });
    }
    const healthUrl = process.env.TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL?.trim();
    try {
      await this.options.runCommand("systemd-run", [
        "--unit", `task-handoff-update-${job.id}`,
        "--collect",
        "--property=Type=exec",
        ...(packaged ? [worker] : [process.execPath, worker]),
        "--job-file", this.options.jobs.records.filePath(job.id),
        "--target-version", job.toVersion,
        "--npm-command", npmCommand(),
        ...(healthUrl ? ["--control-plane-health-url", healthUrl] : []),
      ]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.options.jobs.patch(job.id, {
        status: "failed",
        rollout: { ...job.rollout, phase: "failed" },
        error: {
          code: "NODE_UPDATE_FAILED",
          message: `Failed to launch the node update worker: ${message}`,
          retryable: true,
        },
        completedAt: new Date().toISOString(),
      });
      throw Object.assign(new Error(`Failed to launch the node update worker: ${message}`), {
        statusCode: 500,
        code: "NODE_UPDATE_WORKER_LAUNCH_FAILED",
        cause,
      });
    }
    return job;
  }

  private async consumePreflight(input: ReturnType<typeof NodeAgentApplyUpdateRequestSchema.parse>) {
    const preflight = this.preflights.get(input.preflightToken);
    this.preflights.delete(input.preflightToken);
    if (!preflight || preflight.expiresAt <= Date.now()) {
      throw Object.assign(new Error("The update preflight is missing or expired. Check for updates again."), {
        statusCode: 409,
        code: "UPDATE_PREFLIGHT_EXPIRED",
      });
    }
    const check = preflight.result;
    const selection = await resolveNodeUpdatePackage(this.options.runCommand, this.options.moduleDir);
    const unchanged = check.channel === input.channel
      && check.availableVersion === input.targetVersion
      && check.currentVersion === (selection.currentVersion || this.options.currentRuntimeVersion())
      && check.artifactRef?.startsWith(`npm:${selection.packageName}@`) === true
      && JSON.stringify(check.impact) === JSON.stringify(updateImpact(this.options.listInstances()));
    if (!unchanged) this.throwStale();
    const artifacts = await this.options.resolveRuntimeArtifacts(check.availableVersion);
    if (JSON.stringify(check.runtimeArtifacts) !== JSON.stringify(artifacts)) this.throwStale();
    return check;
  }

  private throwStale(): never {
    throw Object.assign(new Error("The update target or affected instances changed after preflight. Check for updates again."), {
      statusCode: 409,
      code: "UPDATE_PREFLIGHT_STALE",
    });
  }
}

export function registerNodeUpdateRoutes(app: FastifyInstance, controller: NodeUpdateController, jobs: NodeUpdateJobs) {
  app.get("/api/node-agent/updates/jobs", async () => ({ data: jobs.list() }));
  app.post("/api/node-agent/updates/check", async (request) => ({ data: await controller.check(request.body) }));
  app.post("/api/node-agent/updates/apply", async (request, reply) => (
    reply.code(202).send({ data: await controller.apply(request.body) })
  ));
}
