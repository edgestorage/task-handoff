import {
  ImagePullProgressSchema,
  ImagePullTerminalEventType,
  ImagePullTerminalFinishedSchema,
  ImagePullTerminalOutputSchema,
  type ImagePullProgress,
  type ImagePullTerminalFinished,
  type ImagePullTerminalOutput,
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
} from "@task-handoff/protocol/control-plane";
import type { EventEnvelope } from "@task-handoff/protocol/events";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { AnsiTerminalScreen } from "../terminal/ansi-terminal-screen.ts";

const MAX_TERMINAL_TAIL = 256 * 1024;
const PROGRESS_INTERVAL_MS = 250;

type LayerState = {
  status: string;
  current?: number;
  total?: number;
};

type PullState = {
  identity: Pick<ImagePullTerminalOutput, "instanceId" | "generation" | "requestedReference">;
  sequence: number;
  observedAt: string;
  terminal: AnsiTerminalScreen;
  terminalTail: string;
  terminalTruncated: boolean;
  layers: Map<string, LayerState>;
  outcome?: ImagePullTerminalFinished["outcome"];
  progress?: ImagePullProgress;
  timer?: ReturnType<typeof setTimeout>;
};

export class ImagePullProgressProjector {
  private readonly states = new Map<string, PullState>();
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
    if (event.type === ImagePullTerminalEventType.Output) {
      const parsed = safeParseResponse(ImagePullTerminalOutputSchema, event.payload);
      if (parsed.success) this.applyOutput(parsed.data);
      return;
    }
    if (event.type === ImagePullTerminalEventType.Finished) {
      const parsed = safeParseResponse(ImagePullTerminalFinishedSchema, event.payload);
      if (parsed.success) this.applyFinished(parsed.data);
    }
  }

  snapshots() {
    return [...this.states.values()]
      .filter((state) => state.progress)
      .map((state) => ImagePullProgressSchema.parse({
        ...state.progress!,
        terminalTail: state.terminalTail,
        ...(state.terminalTruncated ? { terminalTruncated: true } : {}),
      }));
  }

  close() {
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
    this.states.clear();
  }

  private deleteState(instanceId: string) {
    const state = this.states.get(instanceId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(instanceId);
  }

  private reconcileLifecycle(lifecycle: { instanceId: string; imageProvisioning?: { generation: number; phase: string } }) {
    const state = this.states.get(lifecycle.instanceId);
    const provisioning = lifecycle.imageProvisioning;
    if (!state) return;
    if (!provisioning || provisioning.generation > state.identity.generation
      || (provisioning.generation === state.identity.generation && provisioning.phase === "ready")) {
      this.deleteState(lifecycle.instanceId);
    }
  }

  private applyOutput(output: ImagePullTerminalOutput) {
    const current = this.states.get(output.instanceId);
    if (current && output.generation < current.identity.generation) return;
    if (current && output.generation === current.identity.generation && !output.replay && output.sequence <= current.sequence) return;
    const state = this.requireState(output);
    if (output.replay) {
      state.terminal = new AnsiTerminalScreen();
      state.terminalTail = "";
      state.layers.clear();
      state.terminalTruncated = false;
    }
    state.sequence = Math.max(state.sequence, output.sequence);
    state.observedAt = output.observedAt;
    state.terminal.write(output.data);
    const combined = `${state.terminalTail}${output.data}`;
    state.terminalTruncated ||= combined.length > MAX_TERMINAL_TAIL;
    state.terminalTail = combined.slice(-MAX_TERMINAL_TAIL);
    updateLayers(state.layers, state.terminal.text());
    state.progress = progressForState(state);
    this.schedule(state);
  }

  private applyFinished(finished: ImagePullTerminalFinished) {
    const current = this.states.get(finished.instanceId);
    if (current && finished.generation < current.identity.generation) return;
    if (current && finished.generation === current.identity.generation && finished.sequence <= current.sequence) return;
    const state = this.requireState(finished);
    state.sequence = Math.max(state.sequence, finished.sequence);
    state.observedAt = finished.observedAt;
    state.outcome = finished.outcome;
    state.progress = progressForState(state);
    this.publish(state, true);
  }

  private requireState(identity: ImagePullTerminalOutput | ImagePullTerminalFinished) {
    const existing = this.states.get(identity.instanceId);
    if (existing && existing.identity.generation === identity.generation) return existing;
    if (existing?.timer) clearTimeout(existing.timer);
    const state: PullState = {
      identity: {
        instanceId: identity.instanceId,
        generation: identity.generation,
        requestedReference: identity.requestedReference,
      },
      sequence: identity.sequence,
      observedAt: identity.observedAt,
      terminal: new AnsiTerminalScreen(),
      terminalTail: "",
      terminalTruncated: false,
      layers: new Map(),
    };
    this.states.set(identity.instanceId, state);
    return state;
  }

  private schedule(state: PullState) {
    if (state.timer) return;
    state.timer = setTimeout(() => this.publish(state, false), PROGRESS_INTERVAL_MS);
    state.timer.unref?.();
  }

  private publish(state: PullState, terminal: boolean) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.progress) return;
    state.progress = progressForState(state);
    this.events.publish(ImagePullTerminalEventType.Progress, state.progress, {
      topic: "instances",
      scope: { instanceId: state.identity.instanceId },
    });
    if (terminal) {
      // Keep the bounded tail available for reconnects and failed-pull diagnostics.
      state.progress = progressForState(state);
    }
  }
}

function progressForState(state: PullState): ImagePullProgress {
  const layers = [...state.layers.values()];
  const completed = layers.filter((layer) => ["pull complete", "already exists"].includes(layer.status)).length;
  const downloaded = layers.filter((layer) => layer.status === "download complete").length;
  const downloading = layers.filter((layer) => layer.status === "downloading").length;
  const extracting = layers.filter((layer) => layer.status === "extracting").length;
  let current = 0;
  let total = 0;
  for (const layer of layers) {
    if (!layer.total) continue;
    total += layer.total;
    current += ["pull complete", "already exists", "download complete"].includes(layer.status) ? layer.total : Math.min(layer.current || 0, layer.total);
  }
  const status = state.outcome === "failed" ? "failed"
    : state.outcome === "succeeded" ? "complete"
      : extracting > 0 ? "extracting"
        : layers.length > 0 ? "pulling" : "connecting";
  const layersRequiringBytes = layers.filter((layer) => layer.status !== "already exists");
  const hasCompleteByteTotal = layersRequiringBytes.length > 0 && layersRequiringBytes.every((layer) => Boolean(layer.total));
  const percent = hasCompleteByteTotal && total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : undefined;
  const message = status === "failed" ? "Image pull failed"
    : status === "complete" ? "Image pull complete"
      : layers.length ? `${completed}/${layers.length} layers ready${percent === undefined ? "" : ` · ${Math.round(percent)}%`}`
        : "Connecting to image registry";
  return ImagePullProgressSchema.parse({
    ...state.identity,
    sequence: state.sequence,
    observedAt: state.observedAt,
    status,
    layers: { total: layers.length, completed, downloaded, downloading, extracting },
    ...(hasCompleteByteTotal && total > 0 ? { bytes: { current, total }, percent } : {}),
    message,
  });
}

function updateLayers(layers: Map<string, LayerState>, screen: string) {
  for (const line of screen.split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{6,64}):\s+(.+)$/i);
    if (!match) continue;
    const [, id, detail] = match;
    const normalized = detail.toLowerCase();
    const status = ["pull complete", "already exists", "download complete", "pulling fs layer", "waiting", "downloading", "extracting"]
      .find((candidate) => normalized.startsWith(candidate));
    if (!status) continue;
    const previous = layers.get(id) || { status };
    const bytes = parseProgressBytes(detail);
    layers.set(id, { ...previous, status, ...(bytes || {}) });
  }
}

function parseProgressBytes(value: string) {
  const match = value.match(/([\d.]+)\s*([kmgt]?i?b)\s*\/\s*([\d.]+)\s*([kmgt]?i?b)/i);
  if (!match) return undefined;
  return { current: bytes(match[1], match[2]), total: bytes(match[3], match[4]) };
}

function bytes(value: string, unit: string) {
  const powers: Record<string, number> = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 };
  return Number(value) * (1024 ** (powers[unit.toLowerCase()] || 0));
}
