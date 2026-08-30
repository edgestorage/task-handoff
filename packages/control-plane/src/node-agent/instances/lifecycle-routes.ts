import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ControlledInstanceSchema,
  InstanceDeleteInputSchema,
  type ControlledInstance,
  type NodeRuntime,
} from "@task-handoff/protocol/control-plane";
import type { ExecutorContext } from "../runtimes/docker.ts";
import type { RuntimeAdapterRegistry } from "../runtimes/adapters.ts";
import type { InstanceLifecycleEvent } from "../instance-lifecycle-state.ts";
import { reportedVersion } from "../runtime-convergence.ts";
import { runtimeVersionStateForActual } from "../runtime-version-state.ts";
import { InstanceOperationGate } from "./instance-operation-gate.ts";
import { nowIso as now } from "@task-handoff/core/core/time";
import { GitWorkspaceProvisioningInputSchema, type GitWorkspaceProvisioningInput } from "@task-handoff/protocol/managed-git-credentials";

const LifecycleRequestSchema = z.object({
  // Compatibility for v0.0.21: control planes only send this after the managed-Git capability gate.
  gitWorkspaceProvisioning: GitWorkspaceProvisioningInputSchema.optional(),
}).strict().default({});

type LifecycleState = {
  requireInstance(id: string): ControlledInstance;
  requireRuntime(id: string): NodeRuntime;
  putInstance(instance: ControlledInstance): ControlledInstance;
  deleteInstance(id: string): boolean;
  applyLifecycle(id: string, event: InstanceLifecycleEvent): ControlledInstance;
  context(instance: ControlledInstance, modelEnv?: Record<string, string>): ExecutorContext;
  setGitWorkspaceProvisioning(input: GitWorkspaceProvisioningInput): void;
  discardGitWorkspaceProvisioning(id: string): boolean;
  gitWorkspaceProvisioningStatus(id: string): { status: "pending" | "consumed"; operationId: string } | undefined;
};

type Convergence = {
  cancel(id: string): Promise<unknown> | undefined;
  schedule(id: string, options?: { startRequested?: boolean; resumeCancelled?: boolean }): Promise<ControlledInstance>;
};

type Hooks = {
  start(id: string, shouldContinue?: () => boolean, signal?: AbortSignal): Promise<ControlledInstance>;
  sync(): void;
  isManaged(instance: ControlledInstance): boolean;
  probe(instance: ControlledInstance): Promise<"reachable" | "endpoint-unreachable" | "unknown">;
  autoImport(instance: ControlledInstance): Promise<void>;
  markRestarted(id: string): void;
  allowRecovery(id: string): void;
  suppressRecovery(id: string): Promise<void>;
  forgetRecovery(id: string): void;
  completeSuppressedRecovery(id: string): void;
  deleteMetadata(id: string): void;
  retireInstanceData(id: string): void;
  releaseEnvironmentImage?(imageId: string): Promise<unknown>;
  diagnostic(data: Record<string, unknown>, message: string): void;
};

export function registerInstanceLifecycleRoutes(
  app: FastifyInstance,
  state: LifecycleState,
  adapters: RuntimeAdapterRegistry,
  convergence: Convergence,
  hooks: Hooks,
  operations = new InstanceOperationGate(),
) {
  const intentFor = (id: string) => operations.intent(id);
  const settledCancellation = (id: string) => Promise.resolve(convergence.cancel(id)).then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );
  const assertIntentCurrent = (id: string, intent: object) => {
    if (operations.isIntentCurrent(id, intent)) return;
    throw Object.assign(new Error(`Instance operation for ${id} was superseded by stop or delete.`), {
      statusCode: 409,
      code: "INSTANCE_OPERATION_SUPERSEDED",
    });
  };
  const signalFor = (id: string, intent: object) => {
    const signal = (operations as InstanceOperationGate & { signal?: (instanceId: string, operationIntent: object) => AbortSignal }).signal;
    return typeof signal === "function" ? signal.call(operations, id, intent) : undefined;
  };
  const applyGitProvisioning = (id: string, input: GitWorkspaceProvisioningInput | undefined) => {
    if (!input) return;
    if (input.instanceId !== id) {
      throw Object.assign(new Error(`Git provisioning belongs to ${input.instanceId}, not ${id}.`), {
        code: "GIT_WORKSPACE_PROVISIONING_INSTANCE_MISMATCH",
        statusCode: 409,
      });
    }
    state.setGitWorkspaceProvisioning(input);
  };
  const lifecycleResult = (instance: ControlledInstance, input?: GitWorkspaceProvisioningInput) => {
    if (!input) return instance;
    const status = state.gitWorkspaceProvisioningStatus(instance.id);
    return status?.status === "consumed" && status.operationId === input.operationId
      ? { instance, gitWorkspaceProvisioningOperationId: input.operationId }
      : instance;
  };

  app.post("/api/node-agent/instances/:id/start", async (request) => {
    const body = LifecycleRequestSchema.parse(request.body);
    const id = (request.params as { id: string }).id;
    const intent = intentFor(id);
    return operations.run(id, async () => {
      assertIntentCurrent(id, intent);
      applyGitProvisioning(id, body.gitWorkspaceProvisioning);
      hooks.allowRecovery(id);
      return { data: lifecycleResult(await hooks.start(id, () => operations.isIntentCurrent(id, intent), signalFor(id, intent)), body.gitWorkspaceProvisioning) };
    });
  });

  app.post("/api/node-agent/instances/:id/runtime/reconcile", async (request) => {
    const id = (request.params as { id: string }).id;
    LifecycleRequestSchema.parse(request.body);
    const intent = intentFor(id);
    return operations.run(id, async () => {
      assertIntentCurrent(id, intent);
      const current = state.requireInstance(id);
      state.putInstance(ControlledInstanceSchema.parse({
        ...current,
        ready: false,
        runtimeVersion: runtimeVersionStateForActual(reportedVersion(current)),
        updatedAt: now(),
      }));
      assertIntentCurrent(id, intent);
      const instance = await convergence.schedule(id, {
        startRequested: !["created", "stopped"].includes(current.status),
        resumeCancelled: true,
      });
      assertIntentCurrent(id, intent);
      hooks.sync();
      return { data: instance };
    });
  });

  app.post("/api/node-agent/instances/:id/stop", async (request) => {
    const id = (request.params as { id: string }).id;
    state.requireInstance(id);
    // Stopping is an explicit cancellation boundary for a not-yet-consumed grant.
    state.discardGitWorkspaceProvisioning(id);
    operations.invalidate(id);
    const cancellation = settledCancellation(id);
    return operations.run(id, async () => {
      const baseline = state.requireInstance(id);
      state.applyLifecycle(id, { type: "stop-requested" });
      try {
        await hooks.suppressRecovery(id);
        const cancellationOutcome = await cancellation;
        if ("error" in cancellationOutcome) throw cancellationOutcome.error;
        const current = state.requireInstance(id);
        hooks.diagnostic({ instanceId: id, action: "stop", runtimeId: current.runtimeId, containerName: current.runtime.containerName }, "node instance stop requested");
        await adapters.forRuntime(state.requireRuntime(current.runtimeId)).stop(state.context(current));
      } catch (error) {
        try {
          state.applyLifecycle(id, { type: "stop-failed", baseline });
          hooks.sync();
        } finally {
          hooks.allowRecovery(id);
        }
        throw error;
      }
      const stored = state.applyLifecycle(id, { type: "stop-completed" });
      hooks.completeSuppressedRecovery(id);
      hooks.sync();
      hooks.diagnostic({ instanceId: id, action: "stop", status: stored.status, connectionStatus: stored.connectionStatus, containerName: stored.runtime.containerName }, "node instance stop completed");
      return { data: stored };
    });
  });

  app.post("/api/node-agent/instances/:id/restart", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = LifecycleRequestSchema.parse(request.body);
    const intent = intentFor(id);
    return operations.run(id, async () => {
      assertIntentCurrent(id, intent);
      applyGitProvisioning(id, body.gitWorkspaceProvisioning);
      hooks.allowRecovery(id);
      let current = state.requireInstance(id);
      if (hooks.isManaged(current) && (!current.ready || current.runtimeVersion?.phase !== "matched")) {
        if (current.runtimeVersion?.phase === "failed") {
          current = state.putInstance(ControlledInstanceSchema.parse({
            ...current,
            runtimeVersion: runtimeVersionStateForActual(reportedVersion(current)),
            updatedAt: now(),
          }));
        }
        assertIntentCurrent(id, intent);
        const instance = await convergence.schedule(id, { startRequested: true });
        assertIntentCurrent(id, intent);
        hooks.sync();
        return { data: lifecycleResult(instance, body.gitWorkspaceProvisioning) };
      }
      hooks.diagnostic({ instanceId: id, action: "restart", runtimeId: current.runtimeId, imageId: current.imageSelection?.imageId, containerName: current.runtime.containerName }, "node instance restart requested");
      const result = await adapters.forRuntime(state.requireRuntime(current.runtimeId)).restart(state.context(current));
      let stored = state.applyLifecycle(id, {
        type: "runtime-lifecycle-completed",
        baseline: current,
        observation: {
          ...result,
          target: result.target ? { ...current.target, ...result.target } : undefined,
        },
      });
      hooks.markRestarted(id);
      assertIntentCurrent(id, intent);
      const probeTarget = ControlledInstanceSchema.parse({ ...stored, updatedAt: now() });
      const targetStatus = await hooks.probe(probeTarget);
      assertIntentCurrent(id, intent);
      stored = state.applyLifecycle(id, {
        type: "runtime-lifecycle-completed",
        baseline: stored,
        observation: {
          target: { ...stored.target, status: targetStatus },
          targetStatus,
          uiAccessStatus: targetStatus,
        },
      });
      await hooks.autoImport(stored);
      hooks.sync();
      hooks.diagnostic({ instanceId: id, action: "restart", status: stored.status, connectionStatus: stored.connectionStatus, targetStatus: stored.targetStatus, targetWeb: stored.target.web, containerName: stored.runtime.containerName }, "node instance restart completed");
      return { data: lifecycleResult(stored, body.gitWorkspaceProvisioning) };
    });
  });

  app.post("/api/node-agent/instances/:id/delete", async (request) => {
    const id = (request.params as { id: string }).id;
    const input = InstanceDeleteInputSchema.parse(request.body);
    state.requireInstance(id);
    operations.invalidate(id);
    const cancellation = settledCancellation(id);
    return operations.run(id, async () => {
      const current = state.requireInstance(id);
      if (current.status !== "deleting") state.applyLifecycle(id, { type: "stop-requested" });
      try {
        await hooks.suppressRecovery(id);
        const cancellationOutcome = await cancellation;
        if ("error" in cancellationOutcome) throw cancellationOutcome.error;
        const authoritative = state.requireInstance(id);
        state.putInstance(ControlledInstanceSchema.parse({
          ...authoritative,
          status: "deleting",
          ready: false,
          updatedAt: now(),
        }));
        hooks.diagnostic({ instanceId: id, action: "delete", runtimeId: authoritative.runtimeId, containerName: authoritative.runtime.containerName }, "node instance delete requested");
        const result = await adapters.forRuntime(state.requireRuntime(authoritative.runtimeId)).delete(state.context(authoritative, {}), input);
        if (!result.completed) {
          hooks.diagnostic({ instanceId: id, action: "delete", volumeResults: result.volumeResults }, "node instance delete requires retry");
          hooks.sync();
          return { data: result };
        }
        hooks.diagnostic({ instanceId: id, action: "delete" }, "node instance delete completed");
        const deleted = state.deleteInstance(id);
        if (deleted) {
          hooks.forgetRecovery(id);
          operations.clearIntent(id);
        }
        hooks.deleteMetadata(id);
        if (deleted) hooks.retireInstanceData(id);
        if (deleted && authoritative.environmentTemplateOrigin?.imageId && hooks.releaseEnvironmentImage) {
          await hooks.releaseEnvironmentImage(authoritative.environmentTemplateOrigin.imageId).catch((error) => {
            hooks.diagnostic({ instanceId: id, action: "release-environment-image", error: error instanceof Error ? error.message : String(error) }, "environment image cleanup deferred after instance deletion");
          });
        }
        hooks.sync();
        return { data: result };
      } catch (error) {
        try {
          state.putInstance(ControlledInstanceSchema.parse({ ...current, updatedAt: now() }));
          hooks.sync();
        } finally {
          hooks.allowRecovery(id);
        }
        throw error;
      }
    });
  });
}
