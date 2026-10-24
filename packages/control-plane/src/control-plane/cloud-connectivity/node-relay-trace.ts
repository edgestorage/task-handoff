import {
  RelayTraceRecorder,
  type RelayTraceRecorderOptions,
  type RelayTraceRecordInput,
  type RelayTraceStatus,
} from "./relay-trace.ts";

/**
 * Opt-in capture for the Control Plane -> cloud Relay -> node agent channel.
 *
 * This is deliberately separate from `TASK_HANDOFF_RELAY_TRACE`, which captures
 * devices reaching the Control Plane. `TASK_HANDOFF_NODE_RELAY_TRACE` records
 * the decoded, end-to-end Node Relay frames in both directions, including the
 * exact sealed and relay-frame byte counts paid on the wire. The Relay itself
 * still only sees ciphertext. Bodies are capped and the file rotates, just like
 * the device relay capture.
 */
export const NODE_RELAY_TRACE_FILE_NAME = "node-relay-trace.jsonl";

export type NodeRelayTraceRecordInput = RelayTraceRecordInput & {
  nodeId: string;
  nodeHandle?: string;
  relayChannelId?: string;
};

export class NodeRelayTraceRecorder {
  private readonly recorder: RelayTraceRecorder;

  constructor(options: Omit<RelayTraceRecorderOptions, "fileName" | "entryType"> = {}) {
    this.recorder = new RelayTraceRecorder({
      ...options,
      fileName: NODE_RELAY_TRACE_FILE_NAME,
      entryType: "node-relay-trace-entry",
    });
  }

  get enabled() { return this.recorder.enabled; }

  record(input: NodeRelayTraceRecordInput) {
    const { nodeId, nodeHandle, relayChannelId, ...entry } = input;
    this.recorder.record({
      ...entry,
      detail: {
        ...(entry.detail ?? {}),
        nodeId,
        ...(nodeHandle ? { nodeHandle } : {}),
        ...(relayChannelId ? { relayChannelId } : {}),
      },
    });
  }

  status(): RelayTraceStatus {
    return this.recorder.status();
  }

  close() {
    this.recorder.close();
  }
}

export function nodeRelayTraceFromEnvironment(env: Record<string, string | undefined> = process.env, directory?: string) {
  const configured = env.TASK_HANDOFF_NODE_RELAY_TRACE_DIR?.trim();
  return new NodeRelayTraceRecorder({
    enabled: nodeRelayTraceEnabled(env),
    directory: configured || directory,
    maxBytes: positive(Number(env.TASK_HANDOFF_NODE_RELAY_TRACE_BYTES)),
    backupCount: nonNegative(Number(env.TASK_HANDOFF_NODE_RELAY_TRACE_BACKUPS)),
    maxEntryBytes: positive(Number(env.TASK_HANDOFF_NODE_RELAY_TRACE_ENTRY_BYTES)),
  });
}

/** Only the Node Relay capture's own flag counts; neither other trace starts it. */
export function nodeRelayTraceEnabled(env: Record<string, string | undefined> = process.env) {
  const value = env.TASK_HANDOFF_NODE_RELAY_TRACE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
