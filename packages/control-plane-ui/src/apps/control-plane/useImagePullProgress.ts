import { reactive } from "vue";
import {
  ImagePullProgressSchema,
  ImagePullTerminalEventType,
  ImagePullTerminalOutputSchema,
  type ImagePullProgress,
  type InstanceLifecycleSnapshot,
} from "@task-handoff/protocol/control-plane";

const MAX_TERMINAL_TAIL = 256 * 1024;

type PullViewState = ImagePullProgress;

export function useImagePullProgress() {
  const byInstanceId = reactive<Record<string, PullViewState>>({});

  function applyEvent(type: string, payload: unknown) {
    if (type === ImagePullTerminalEventType.Output) {
      const parsed = ImagePullTerminalOutputSchema.safeParse(payload);
      if (!parsed.success) return false;
      const output = parsed.data;
      const previous = byInstanceId[output.instanceId];
      if (previous && output.generation < previous.generation) return true;
      const current = !previous || output.generation > previous.generation ? {
        instanceId: output.instanceId,
        generation: output.generation,
        requestedReference: output.requestedReference,
        sequence: output.sequence,
        observedAt: output.observedAt,
        status: "connecting" as const,
        layers: { total: 0, completed: 0, downloaded: 0, downloading: 0, extracting: 0 },
        message: "connecting",
      } : previous;
      const terminalTail = output.replay ? output.data : `${current.terminalTail || ""}${output.data}`.slice(-MAX_TERMINAL_TAIL);
      byInstanceId[output.instanceId] = { ...current, sequence: Math.max(current.sequence, output.sequence), observedAt: output.observedAt, terminalTail };
      return true;
    }
    if (type !== ImagePullTerminalEventType.Progress && type !== ImagePullTerminalEventType.Snapshot) return false;
    const parsed = ImagePullProgressSchema.safeParse(payload);
    if (!parsed.success) return false;
    const progress = parsed.data;
    const current = byInstanceId[progress.instanceId];
    if (current && progress.generation < current.generation) return true;
    byInstanceId[progress.instanceId] = {
      ...progress,
      terminalTail: progress.terminalTail ?? current?.terminalTail,
      terminalTruncated: progress.terminalTruncated ?? current?.terminalTruncated,
    };
    return true;
  }

  function reconcileLifecycle(lifecycle: InstanceLifecycleSnapshot) {
    const current = byInstanceId[lifecycle.instanceId];
    if (!current) return;
    const provisioning = lifecycle.imageProvisioning;
    if (!provisioning || provisioning.generation > current.generation
      || (provisioning.generation === current.generation && provisioning.phase === "ready")) {
      delete byInstanceId[lifecycle.instanceId];
    }
  }

  return {
    applyEvent,
    clear: (instanceId: string) => { delete byInstanceId[instanceId]; },
    reconcileLifecycle,
    state: (instanceId: string) => byInstanceId[instanceId],
  };
}
