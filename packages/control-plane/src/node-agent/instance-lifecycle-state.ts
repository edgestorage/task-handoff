import {
  ControlledInstanceSchema,
  type ControlledInstance,
} from "@task-handoff/protocol/control-plane";

export type RuntimeLifecycleObservation = {
  status?: ControlledInstance["status"];
  health?: ControlledInstance["health"];
  connectionStatus?: ControlledInstance["connectionStatus"];
  agentStatus?: ControlledInstance["agentStatus"];
  targetStatus?: ControlledInstance["targetStatus"];
  uiAccessStatus?: ControlledInstance["uiAccessStatus"];
  target?: Partial<ControlledInstance["target"]>;
  workspace?: Partial<ControlledInstance["workspace"]>;
  runtime?: Partial<ControlledInstance["runtime"]>;
};

export type InstanceLifecycleEvent =
  | { type: "start-requested" }
  | { type: "stop-requested" }
  | { type: "stop-failed"; baseline: ControlledInstance }
  | { type: "convergence-restart-requested" }
  | {
      type: "runtime-lifecycle-completed";
      baseline: ControlledInstance;
      observation: RuntimeLifecycleObservation;
    }
  | { type: "stop-completed" }
  | { type: "runtime-exited"; error: unknown }
  | { type: "start-failed"; error: unknown };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeLifecycleCompleted(
  baseline: ControlledInstance,
  latest: ControlledInstance,
  observation: RuntimeLifecycleObservation,
  observedAt: string,
) {
  const supersededByTerminalLifecycle = latest.stateRevision > baseline.stateRevision
    && ["failed", "stopping", "stopped"].includes(latest.status);
  if (supersededByTerminalLifecycle) return latest;
  const hasFreshProcessReport = latest.stateRevision > baseline.stateRevision
    && latest.lastHeartbeatAt !== baseline.lastHeartbeatAt
    && latest.agentStatus === "online";
  return ControlledInstanceSchema.parse({
    ...latest,
    ...observation,
    ...(hasFreshProcessReport ? {
      status: latest.status,
      health: latest.health,
      connectionStatus: latest.connectionStatus,
      agentStatus: latest.agentStatus,
      targetStatus: latest.targetStatus,
      uiAccessStatus: latest.uiAccessStatus,
    } : {}),
    ready: hasFreshProcessReport ? latest.ready : false,
    target: observation.target
      ? hasFreshProcessReport ? { ...observation.target, ...latest.target } : { ...latest.target, ...observation.target }
      : latest.target,
    workspace: observation.workspace
      ? hasFreshProcessReport ? { ...observation.workspace, ...latest.workspace } : { ...latest.workspace, ...observation.workspace }
      : latest.workspace,
    runtime: observation.runtime ? { ...latest.runtime, ...observation.runtime } : latest.runtime,
    updatedAt: observedAt,
  });
}

export function reduceInstanceLifecycle(
  current: ControlledInstance,
  event: InstanceLifecycleEvent,
  observedAt = new Date().toISOString(),
) {
  switch (event.type) {
    case "start-requested":
      return ControlledInstanceSchema.parse({
        ...current,
        status: "starting",
        ready: false,
        updatedAt: observedAt,
      });
    case "stop-requested":
      return ControlledInstanceSchema.parse({
        ...current,
        status: "stopping",
        ready: false,
        updatedAt: observedAt,
      });
    case "stop-failed":
      if (current.status !== "stopping") return current;
      return ControlledInstanceSchema.parse({
        ...current,
        status: event.baseline.status,
        health: event.baseline.health,
        connectionStatus: event.baseline.connectionStatus,
        agentStatus: event.baseline.agentStatus,
        targetStatus: event.baseline.targetStatus,
        uiAccessStatus: event.baseline.uiAccessStatus,
        ready: event.baseline.ready,
        target: {
          ...current.target,
          status: event.baseline.target.status,
        },
        updatedAt: observedAt,
      });
    case "convergence-restart-requested":
      return ControlledInstanceSchema.parse({
        ...current,
        build: undefined,
        instanceVersion: undefined,
        ready: false,
        updatedAt: observedAt,
      });
    case "runtime-lifecycle-completed":
      return runtimeLifecycleCompleted(event.baseline, current, event.observation, observedAt);
    case "stop-completed":
      return ControlledInstanceSchema.parse({
        ...current,
        status: "stopped",
        health: "unknown",
        connectionStatus: "offline",
        ready: false,
        agentStatus: "offline",
        targetStatus: "unknown",
        uiAccessStatus: "unknown",
        target: {
          ...current.target,
          status: "unknown",
        },
        updatedAt: observedAt,
      });
    case "runtime-exited":
    case "start-failed":
      return ControlledInstanceSchema.parse({
        ...current,
        status: "failed",
        ready: false,
        health: "failed",
        connectionStatus: "offline",
        agentStatus: "offline",
        targetStatus: "unknown",
        uiAccessStatus: "unknown",
        workspace: {
          ...current.workspace,
          error: errorMessage(event.error),
        },
        updatedAt: observedAt,
      });
  }
}

export function mergeRuntimeLifecycleResult(
  baseline: ControlledInstance,
  latest: ControlledInstance,
  observation: RuntimeLifecycleObservation,
) {
  return reduceInstanceLifecycle(latest, {
    type: "runtime-lifecycle-completed",
    baseline,
    observation,
  });
}
