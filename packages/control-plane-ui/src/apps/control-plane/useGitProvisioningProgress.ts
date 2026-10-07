import { reactive } from "vue";
import {
  GitProvisioningProgressSchema,
  GitProvisioningTerminalEventType,
  GitProvisioningTerminalOutputSchema,
  type GitProvisioningProgress,
  type InstanceLifecycleSnapshot,
} from "@task-handoff/protocol/control-plane";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";

const MAX_TERMINAL_TAIL = 256 * 1024;

type ProvisioningViewState = GitProvisioningProgress;

export function useGitProvisioningProgress() {
  const byInstanceId = reactive<Record<string, ProvisioningViewState>>({});

  function applyEvent(type: string, payload: unknown) {
    if (type === GitProvisioningTerminalEventType.Output) {
      const parsed = safeParseResponse(GitProvisioningTerminalOutputSchema, payload);
      if (!parsed.success) return false;
      const output = parsed.data;
      const previous = byInstanceId[output.instanceId];
      if (previous && output.generation < previous.generation) return true;
      const current = !previous || output.generation > previous.generation ? {
        instanceId: output.instanceId,
        generation: output.generation,
        remoteUrl: output.remoteUrl,
        sequence: output.sequence,
        observedAt: output.observedAt,
        status: "connecting" as const,
        message: "connecting",
      } : previous;
      const terminalTail = output.replay ? output.data : `${current.terminalTail || ""}${output.data}`.slice(-MAX_TERMINAL_TAIL);
      byInstanceId[output.instanceId] = { ...current, sequence: Math.max(current.sequence, output.sequence), observedAt: output.observedAt, terminalTail };
      return true;
    }
    if (type !== GitProvisioningTerminalEventType.Progress && type !== GitProvisioningTerminalEventType.Snapshot) return false;
    const parsed = safeParseResponse(GitProvisioningProgressSchema, payload);
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
    const provisioning = lifecycle.workspace.gitProvisioning;
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
