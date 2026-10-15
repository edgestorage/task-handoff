import path from "node:path";
import { createHash } from "node:crypto";
import { appendRotatingLogSync, DEFAULT_OPEN_LOG_BACKUP_COUNT, DEFAULT_OPEN_LOG_MAX_BYTES } from "@task-handoff/core/storage/open-log-retention";

/**
 * Relay traffic capture for diagnosing "why is the relay moving so much data".
 *
 * Deliberately independent from TASK_HANDOFF_DIAGNOSTIC_LOGS: enabling diagnostic
 * logging must never start writing relay payloads, and this capture never appends
 * to the log stream. It is opt-in through its own flag and writes to its own file.
 *
 * The file rolls over exactly like a managed log (`appendRotatingLogSync`): the live
 * `relay-trace.jsonl` is capped, older content moves to `.1`, `.2`, ... and the oldest
 * generation is overwritten, so the capture always holds the most recent window and the
 * total on disk stays bounded.
 *
 * Each entry pairs the decoded envelope with the sizes it costs on the wire
 * (`plaintextBytes` < `sealedBytes` < `wireBytes`), which is the whole point: the Relay
 * and every hop in between carry the base64 ciphertext, never the plaintext. Bodies are
 * kept verbatim up to `TASK_HANDOFF_RELAY_TRACE_ENTRY_BYTES` and always carry a digest.
 */
export type RelayTraceDirection = "in" | "out";

export type RelayTraceEntry = {
  type: "relay-trace-entry";
  at: string;
  channelId: string;
  direction: RelayTraceDirection;
  kind: string;
  plaintextBytes: number;
  sealedBytes: number;
  wireBytes: number;
  detail?: Record<string, unknown>;
  body?: string;
  bodyDigest?: string;
  truncated?: boolean;
};

export type RelayTraceStatus = {
  enabled: boolean;
  path?: string;
  maxBytes: number;
  backupCount: number;
  maxEntryBytes: number;
  writtenBytes: number;
  writtenEntries: number;
  error?: string;
};

export type RelayTraceRecordInput = {
  channelId: string;
  direction: RelayTraceDirection;
  kind: string;
  plaintext: Uint8Array;
  sealedBytes: number;
  wireBytes: number;
  detail?: Record<string, unknown>;
};

/** One rolling file plus one backup: the 20 MB budget the capture is allowed to hold. */
export const DEFAULT_RELAY_TRACE_MAX_BYTES = DEFAULT_OPEN_LOG_MAX_BYTES;
export const DEFAULT_RELAY_TRACE_BACKUP_COUNT = DEFAULT_OPEN_LOG_BACKUP_COUNT - 1;
export const DEFAULT_RELAY_TRACE_ENTRY_BYTES = 16 * 1024;
export const RELAY_TRACE_FILE_NAME = "relay-trace.jsonl";

export type RelayTraceRecorderOptions = {
  enabled?: boolean;
  directory?: string;
  maxBytes?: number;
  backupCount?: number;
  maxEntryBytes?: number;
  clock?: () => number;
};

export class RelayTraceRecorder {
  private readonly enabledFlag: boolean;
  private readonly filePath?: string;
  private readonly maxBytes: number;
  private readonly backupCount: number;
  private readonly maxEntryBytes: number;
  private readonly clock: () => number;
  private writtenBytes = 0;
  private writtenEntries = 0;
  private error?: string;
  private failed = false;

  constructor(options: RelayTraceRecorderOptions = {}) {
    this.enabledFlag = options.enabled ?? false;
    this.filePath = options.directory ? path.join(options.directory, RELAY_TRACE_FILE_NAME) : undefined;
    this.maxBytes = positive(options.maxBytes) ?? DEFAULT_RELAY_TRACE_MAX_BYTES;
    this.backupCount = nonNegative(options.backupCount) ?? DEFAULT_RELAY_TRACE_BACKUP_COUNT;
    this.maxEntryBytes = positive(options.maxEntryBytes) ?? DEFAULT_RELAY_TRACE_ENTRY_BYTES;
    this.clock = options.clock ?? Date.now;
  }

  get enabled() { return this.enabledFlag; }

  record(input: RelayTraceRecordInput) {
    if (!this.enabledFlag || this.failed) return;
    const entry: RelayTraceEntry = {
      type: "relay-trace-entry",
      at: new Date(this.clock()).toISOString(),
      channelId: input.channelId,
      direction: input.direction,
      kind: input.kind,
      plaintextBytes: input.plaintext.byteLength,
      sealedBytes: input.sealedBytes,
      wireBytes: input.wireBytes,
      ...(input.detail && Object.keys(input.detail).length ? { detail: input.detail } : {}),
      ...captureBody(input.plaintext, this.maxEntryBytes),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (!this.filePath) { this.error = "capture-directory-unavailable"; this.failed = true; return; }
    try {
      appendRotatingLogSync(this.filePath, line, this.maxBytes, this.backupCount);
    } catch (cause) {
      // Capture is diagnostic: a broken path must never break relaying, but it must not be
      // retried per envelope either. Stop after the first failure and report it.
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.failed = true;
      return;
    }
    this.writtenBytes += Buffer.byteLength(line, "utf8");
    this.writtenEntries += 1;
  }

  status(): RelayTraceStatus {
    return {
      enabled: this.enabledFlag,
      ...(this.filePath ? { path: this.filePath } : {}),
      maxBytes: this.maxBytes,
      backupCount: this.backupCount,
      maxEntryBytes: this.maxEntryBytes,
      writtenBytes: this.writtenBytes,
      writtenEntries: this.writtenEntries,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  close() {
    // The capture appends per envelope and keeps no open handle, so there is nothing to
    // flush on shutdown; rotating on stop would only hide the newest traffic.
  }
}

export function relayTraceFromEnvironment(env: Record<string, string | undefined> = process.env, directory?: string) {
  const configured = env.TASK_HANDOFF_RELAY_TRACE_DIR?.trim();
  return new RelayTraceRecorder({
    enabled: relayTraceEnabled(env),
    directory: configured || directory,
    maxBytes: positive(Number(env.TASK_HANDOFF_RELAY_TRACE_BYTES)),
    backupCount: nonNegative(Number(env.TASK_HANDOFF_RELAY_TRACE_BACKUPS)),
    maxEntryBytes: positive(Number(env.TASK_HANDOFF_RELAY_TRACE_ENTRY_BYTES)),
  });
}

/** Only this capture's own explicit opt-in counts; diagnostic logging stays a separate switch. */
export function relayTraceEnabled(env: Record<string, string | undefined> = process.env) {
  const value = env.TASK_HANDOFF_RELAY_TRACE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function captureBody(plaintext: Uint8Array, maxEntryBytes: number) {
  const digest = { bodyDigest: `sha256:${createHash("sha256").update(plaintext).digest("base64url")}` };
  if (plaintext.byteLength <= maxEntryBytes) return { body: Buffer.from(plaintext).toString("utf8"), ...digest };
  return { body: Buffer.from(plaintext.subarray(0, maxEntryBytes)).toString("utf8"), ...digest, truncated: true };
}
