import {
  GitProvisioningProgressSchema,
  GitProvisioningTerminalEventType,
  GitProvisioningTerminalFinishedSchema,
  GitProvisioningTerminalOutputSchema,
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  type GitProvisioningProgress,
  type GitProvisioningTerminalFinished,
  type GitProvisioningTerminalOutput,
} from "@task-handoff/protocol/control-plane";
import { GitProvisioningTerminalParser, type GitProvisioningStage } from "@task-handoff/protocol/workspace-git";
import type { EventEnvelope } from "@task-handoff/protocol/events";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { AnsiTerminalScreen } from "../terminal/ansi-terminal-screen.ts";

const MAX_TERMINAL_TAIL = 256 * 1024;
const PROGRESS_INTERVAL_MS = 250;

type GitProgressLine = {
  received?: number;
  total?: number;
  percent?: number;
};

type ProvisioningState = {
  identity: Pick<GitProvisioningTerminalOutput, "instanceId" | "generation" | "remoteUrl">;
  sequence: number;
  observedAt: string;
  parser: GitProvisioningTerminalParser;
  terminal: AnsiTerminalScreen;
  terminalTail: string;
  terminalTruncated: boolean;
  stage?: GitProvisioningStage;
  outcome?: GitProvisioningTerminalFinished["outcome"];
  progress?: GitProvisioningProgress;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Derives the user-facing Git clone progress from the provisioning terminal
 * stream. The node agent owns materialization; this projector only re-reads the
 * authoritative markers and git output, exactly like image pull projection.
 */
export class GitProvisioningProgressProjector {
  private readonly states = new Map<string, ProvisioningState>();
  private readonly events: ControlPlaneEventBus;

  constructor(events: ControlPlaneEventBus) {
    this.events = events;
  }

  handle(event: EventEnvelope) {
    if (event.type === InstanceLifecycleEventType.Snapshot) {
      const parsed = safeParseResponse(InstanceLifecycleSnapshotSchema, event.payload);
      if (parsed.success) this.reconcileLifecycle(parsed.data);
      return;
    }
    if (event.type === "instance.deleted") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "") : "";
      if (instanceId) this.deleteState(instanceId);
      return;
    }
    if (event.type === GitProvisioningTerminalEventType.Output) {
      const parsed = safeParseResponse(GitProvisioningTerminalOutputSchema, event.payload);
      if (parsed.success) this.applyOutput(parsed.data);
      return;
    }
    if (event.type === GitProvisioningTerminalEventType.Finished) {
      const parsed = safeParseResponse(GitProvisioningTerminalFinishedSchema, event.payload);
      if (parsed.success) this.applyFinished(parsed.data);
    }
  }

  snapshots() {
    return [...this.states.values()]
      .filter((state) => state.progress)
      .map((state) => GitProvisioningProgressSchema.parse({
        ...state.progress!,
        terminalTail: state.terminalTail,
        ...(state.terminalTruncated ? { terminalTruncated: true } : {}),
      }));
  }

  close() {
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
    this.states.clear();
  }

  private applyOutput(output: GitProvisioningTerminalOutput) {
    const current = this.states.get(output.instanceId);
    if (current && output.generation < current.identity.generation) return;
    if (current && output.generation === current.identity.generation && !output.replay && output.sequence <= current.sequence) return;
    const state = this.requireState(output);
    const parsed = state.parser.push(output.data);
    if (output.replay) {
      state.terminal = new AnsiTerminalScreen();
      state.terminalTail = "";
      state.terminalTruncated = false;
    }
    if (parsed.stage) state.stage = parsed.stage;
    state.sequence = Math.max(state.sequence, output.sequence);
    state.observedAt = output.observedAt;
    state.terminal.write(parsed.display);
    const combined = `${state.terminalTail}${parsed.display}`;
    state.terminalTruncated ||= combined.length > MAX_TERMINAL_TAIL;
    state.terminalTail = combined.slice(-MAX_TERMINAL_TAIL);
    state.progress = progressForState(state);
    this.schedule(state);
  }

  private applyFinished(finished: GitProvisioningTerminalFinished) {
    const current = this.states.get(finished.instanceId);
    if (current && finished.generation < current.identity.generation) return;
    if (current && finished.generation === current.identity.generation && finished.sequence <= current.sequence) return;
    const state = this.requireState(finished);
    const remainder = state.parser.flush();
    if (remainder) {
      state.terminal.write(remainder);
      state.terminalTail = `${state.terminalTail}${remainder}`.slice(-MAX_TERMINAL_TAIL);
    }
    state.sequence = Math.max(state.sequence, finished.sequence);
    state.observedAt = finished.observedAt;
    state.outcome = finished.outcome;
    state.progress = progressForState(state);
    this.publish(state);
  }

  private requireState(identity: GitProvisioningTerminalOutput | GitProvisioningTerminalFinished) {
    const existing = this.states.get(identity.instanceId);
    if (existing && existing.identity.generation === identity.generation) return existing;
    if (existing?.timer) clearTimeout(existing.timer);
    const state: ProvisioningState = {
      identity: {
        instanceId: identity.instanceId,
        generation: identity.generation,
        remoteUrl: identity.remoteUrl,
      },
      sequence: identity.sequence,
      observedAt: identity.observedAt,
      parser: new GitProvisioningTerminalParser(),
      terminal: new AnsiTerminalScreen(),
      terminalTail: "",
      terminalTruncated: false,
    };
    this.states.set(identity.instanceId, state);
    return state;
  }

  private schedule(state: ProvisioningState) {
    if (state.timer) return;
    state.timer = setTimeout(() => this.publish(state), PROGRESS_INTERVAL_MS);
    state.timer.unref?.();
  }

  private publish(state: ProvisioningState) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.progress) return;
    state.progress = progressForState(state);
    this.events.publish(GitProvisioningTerminalEventType.Progress, state.progress, {
      topic: "instances",
      scope: { instanceId: state.identity.instanceId },
    });
  }

  private deleteState(instanceId: string) {
    const state = this.states.get(instanceId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(instanceId);
  }

  private reconcileLifecycle(lifecycle: { instanceId: string; workspace: { gitProvisioning?: { generation: number; phase: string } } }) {
    const state = this.states.get(lifecycle.instanceId);
    if (!state) return;
    const provisioning = lifecycle.workspace.gitProvisioning;
    // Keep failed provisioning visible so the failure reason stays readable.
    if (!provisioning || provisioning.generation > state.identity.generation
      || (provisioning.generation === state.identity.generation && provisioning.phase === "ready")) {
      this.deleteState(lifecycle.instanceId);
    }
  }
}

function progressForState(state: ProvisioningState): GitProvisioningProgress {
  const parsed = latestGitProgress(state.terminal.text());
  const status = state.outcome === "failed" ? "failed"
    : state.outcome === "succeeded" ? "complete"
      : state.stage || (parsed ? "cloning" : "connecting");
  const objects = parsed?.received !== undefined && parsed?.total !== undefined
    ? { received: parsed.received, total: parsed.total }
    : undefined;
  const message = status === "failed" ? "Git workspace provisioning failed"
    : status === "complete" ? "Git workspace provisioning complete"
      : gitStageMessage(status, objects, parsed?.percent);
  return GitProvisioningProgressSchema.parse({
    ...state.identity,
    sequence: state.sequence,
    observedAt: state.observedAt,
    status,
    ...(objects ? { objects } : {}),
    ...(parsed?.percent !== undefined ? { percent: parsed.percent } : {}),
    message,
  });
}

function gitStageMessage(status: GitProvisioningProgress["status"], objects: { received: number; total: number } | undefined, percent: number | undefined) {
  const label = status === "cloning" ? "Cloning repository"
    : status === "checking-out" ? "Checking out files"
      : status === "submodules" ? "Updating submodules"
        : status === "lfs" ? "Downloading LFS objects"
          : status === "finalizing" ? "Finalizing workspace"
            : "Connecting to Git remote";
  const parts = [label];
  if (objects) parts.push(`${objects.received}/${objects.total} objects`);
  if (percent !== undefined) parts.push(`${Math.round(percent)}%`);
  return parts.join(" · ");
}

function latestGitProgress(screen: string): GitProgressLine | undefined {
  let latest: GitProgressLine | undefined;
  for (const line of screen.split("\n")) {
    const parsed = parseGitProgressLine(line);
    if (parsed) latest = parsed;
  }
  return latest;
}

export function parseGitProgressLine(line: string): GitProgressLine | undefined {
  const match = line.trim().match(/^[^:]+:\s+(\d{1,3})%\s*\((\d+)\/(\d+)\)/);
  if (!match) return undefined;
  const percent = Number(match[1]);
  const received = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(percent) || !Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return undefined;
  return {
    received,
    total,
    percent: Math.max(0, Math.min(100, percent)),
  };
}
