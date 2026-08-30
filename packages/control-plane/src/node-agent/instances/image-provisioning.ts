import {
  ControlledInstanceSchema,
  ImagePullTerminalEventType,
  type ControlledInstance,
} from "@task-handoff/protocol/control-plane";
import {
  type DockerImagePhase,
  type DockerImageTerminalOutput,
  type ResolvedDockerImage,
  DockerImageService,
} from "../docker-images.ts";
import type { NodeAgentState } from "../state.ts";
import { nowIso as now } from "@task-handoff/core/core/time";

type Diagnostic = (data: Record<string, unknown>, message: string) => void;

type Options = {
  sync(): void;
  diagnostic: Diagnostic;
  warn: Diagnostic;
  publish(type: string, payload: Record<string, unknown>, instanceId: string): void;
  runInstanceOperation?<T>(instanceId: string, operation: () => Promise<T>): Promise<T>;
};

function splitTerminalOutput(data: string, maxLength = 60_000) {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += maxLength) chunks.push(data.slice(offset, offset + maxLength));
  return chunks;
}

export function resolvedDockerImageUpdatePatch(
  instance: ControlledInstance,
  resolvedImage: ResolvedDockerImage,
  timestamp = now(),
) {
  if (!instance.imageSnapshot) throw new Error(`Instance ${instance.id} does not have an image snapshot.`);
  return {
    imageSnapshot: {
      ...instance.imageSnapshot,
      requestedReference: resolvedImage.requestedReference,
      resolvedDigest: resolvedImage.resolvedDigest,
      resolvedReference: resolvedImage.resolvedReference,
      updatedAt: timestamp,
    },
    imageProvisioning: {
      phase: "ready" as const,
      requestedReference: resolvedImage.requestedReference,
      generation: (instance.imageProvisioning?.generation || 0) + 1,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export class InstanceImageProvisioningController {
  private readonly state: NodeAgentState;
  private readonly images: DockerImageService;
  private readonly options: Options;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortController = new AbortController();
  private stopped = false;

  constructor(state: NodeAgentState, images: DockerImageService, options: Options) {
    this.state = state;
    this.images = images;
    this.options = options;
  }

  retry(id: string) {
    const current = this.state.requireInstance(id);
    const runtime = this.state.requireRuntime(current.runtimeId);
    if (runtime.type !== "docker" || !current.imageSnapshot) {
      throw Object.assign(new Error(`Instance ${id} does not use a Docker image.`), {
        statusCode: 400,
        code: "INSTANCE_IMAGE_PROVISIONING_UNSUPPORTED",
      });
    }
    if (current.status !== "failed" || current.imageProvisioning?.phase !== "failed") {
      throw Object.assign(new Error(`Instance ${id} does not have failed image provisioning to retry.`), {
        statusCode: 409,
        code: "INSTANCE_IMAGE_PROVISIONING_NOT_FAILED",
      });
    }
    const timestamp = now();
    return this.state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      status: "provisioning",
      health: "unknown",
      imageProvisioning: {
        phase: "checking-image",
        requestedReference: current.imageSnapshot.requestedReference,
        generation: (current.imageProvisioning?.generation || 0) + 1,
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }));
  }

  provision(instance: ControlledInstance, onReadyToStart?: () => Promise<void>) {
    if (this.stopped) return Promise.resolve();
    const generation = instance.imageProvisioning?.generation;
    if (generation === undefined) return Promise.resolve();
    const key = `${instance.id}:${generation}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.provisionGeneration(instance, generation, onReadyToStart)
      .finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  async stop() {
    this.stopped = true;
    this.abortController.abort();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async provisionGeneration(
    instance: ControlledInstance,
    generation: number,
    onReadyToStart?: () => Promise<void>,
  ) {
    const initial = this.currentGeneration(instance.id, generation, true, instance.createdAt);
    if (!initial) return;
    let terminalSequence = 0;
    let terminalStarted = false;
    let phaseFailure: { error: unknown } | undefined;
    let phaseUpdates = Promise.resolve();
    try {
      const resolved = await this.images.ensure(
        initial.imageSnapshot!.requestedReference!,
        (phase) => {
          phaseUpdates = phaseUpdates.then(async () => {
            if (phaseFailure) return;
            try {
              await this.updatePhase(instance.id, generation, phase, instance.createdAt);
            } catch (error) {
              phaseFailure = { error };
            }
          });
        },
        (output) => {
          if (this.stopped) return;
          terminalStarted = true;
          terminalSequence = output.sequence;
          this.publishTerminalOutput(instance, generation, output);
        },
        this.abortController.signal,
      );
      await phaseUpdates;
      if (phaseFailure) throw phaseFailure.error;
      if (this.stopped) return;
      if (terminalStarted) this.publishFinished(instance, generation, terminalSequence + 1, "succeeded");
      const commit = async () => {
        if (this.stopped) return;
        const current = this.currentGeneration(instance.id, generation, true, instance.createdAt);
        if (!current) return;
        const ready = this.state.controlledInstances.put(ControlledInstanceSchema.parse({
          ...current,
          status: current.status === "provisioning" ? "created" : current.status,
          health: "unknown",
          imageSnapshot: {
            ...current.imageSnapshot!,
            requestedReference: resolved.requestedReference,
            resolvedDigest: resolved.resolvedDigest,
            resolvedReference: resolved.resolvedReference,
          },
          imageProvisioning: { ...current.imageProvisioning!, phase: "ready", error: undefined, updatedAt: now() },
          updatedAt: now(),
        }));
        this.options.sync();
        this.options.diagnostic({
          instanceId: instance.id,
          action: "image.provision",
          reference: resolved.requestedReference,
          digest: resolved.resolvedDigest,
          pulled: resolved.pulled,
        }, "node instance image provisioning completed");
        if (ready.status === "starting") await onReadyToStart?.();
      };
      await (this.options.runInstanceOperation?.(instance.id, commit) ?? commit());
    } catch (error) {
      await phaseUpdates;
      if (phaseFailure) error = phaseFailure.error;
      if (this.stopped) return;
      if (terminalStarted) this.publishFinished(instance, generation, terminalSequence + 1, "failed");
      const message = error instanceof Error ? error.message : String(error);
      const fail = async () => {
        if (this.stopped) return;
        const current = this.currentGeneration(instance.id, generation, false, instance.createdAt);
        if (!current?.imageProvisioning || !["provisioning", "starting"].includes(current.status)) return;
        this.state.controlledInstances.put(ControlledInstanceSchema.parse({
          ...current,
          status: "failed",
          health: "failed",
          imageProvisioning: { ...current.imageProvisioning, phase: "failed", error: message, updatedAt: now() },
          updatedAt: now(),
        }));
        this.options.sync();
        this.options.warn({
          instanceId: instance.id,
          action: "image.provision",
          reference: current.imageProvisioning.requestedReference,
          error: message,
        }, "node instance image provisioning failed");
      };
      await (this.options.runInstanceOperation?.(instance.id, fail) ?? fail());
    }
  }

  private currentGeneration(id: string, generation: number, requireSnapshot = true, createdAt?: string) {
    const current = this.state.controlledInstances.get(id);
    if (!current || (createdAt && current.createdAt !== createdAt) || current.imageProvisioning?.generation !== generation || (requireSnapshot && !current.imageSnapshot)) return undefined;
    return current;
  }

  private async updatePhase(id: string, generation: number, phase: DockerImagePhase, createdAt?: string) {
    if (this.stopped) return;
    const update = async () => {
      if (this.stopped) return;
      const current = this.currentGeneration(id, generation, true, createdAt);
      if (!current || !["provisioning", "starting"].includes(current.status)) return;
      this.state.controlledInstances.put(ControlledInstanceSchema.parse({
        ...current,
        status: current.status === "starting" ? "starting" : "provisioning",
        imageProvisioning: { ...current.imageProvisioning!, phase, error: undefined, updatedAt: now() },
        updatedAt: now(),
      }));
      this.options.sync();
    };
    await (this.options.runInstanceOperation?.(id, update) ?? update());
  }

  private eventBase(instance: ControlledInstance, generation: number) {
    return {
      instanceId: instance.id,
      generation,
      requestedReference: instance.imageProvisioning!.requestedReference,
      observedAt: now(),
    };
  }

  private publishTerminalOutput(instance: ControlledInstance, generation: number, output: DockerImageTerminalOutput) {
    for (const [index, data] of splitTerminalOutput(output.data).entries()) {
      this.options.publish(ImagePullTerminalEventType.Output, {
        ...this.eventBase(instance, generation),
        sequence: output.sequence * 1000 + index,
        data,
        ...(output.replay ? { replay: true } : {}),
      }, instance.id);
    }
  }

  private publishFinished(instance: ControlledInstance, generation: number, sequence: number, outcome: "succeeded" | "failed") {
    this.options.publish(ImagePullTerminalEventType.Finished, {
      ...this.eventBase(instance, generation),
      sequence: sequence * 1000,
      outcome,
    }, instance.id);
  }
}
