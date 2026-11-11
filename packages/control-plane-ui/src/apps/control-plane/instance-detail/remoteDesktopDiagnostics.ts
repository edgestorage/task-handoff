type DiagnosticValue = string | number | boolean | null | undefined;

export type RemoteDesktopDiagnosticFields = Record<string, DiagnosticValue>;
export type RemoteDesktopDiagnosticEntry = RemoteDesktopDiagnosticFields & {
  time: string;
  sequence: number;
  event: string;
};

type DiagnosticSink = (entry: RemoteDesktopDiagnosticEntry) => void;
type DiagnosticOptions = {
  enabled: () => boolean;
  context: () => RemoteDesktopDiagnosticFields;
  sink?: DiagnosticSink;
  maxEntries?: number;
};

const DEFAULT_MAX_ENTRIES = 80;
const DESKTOP_MESSAGE_LIMIT = 240;
const DESKTOP_CHUNK_LENGTH = 150;

function bounded(value: unknown, limit: number) {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined;
}

/** Formats one diagnostic entry into desktop-shell IPC-sized chunks. The shell
 * truncates each message at 240 characters, so the sequence/count prefix and
 * payload must fit inside that boundary together. */
export function formatRemoteDesktopDiagnosticMessages(entry: RemoteDesktopDiagnosticEntry) {
  const text = JSON.stringify(entry);
  const count = Math.max(1, Math.ceil(text.length / DESKTOP_CHUNK_LENGTH));
  return Array.from({ length: count }, (_, index) =>
    `remote-desktop ${entry.sequence} ${entry.event} ${index + 1}/${count} ${text.slice(index * DESKTOP_CHUNK_LENGTH, (index + 1) * DESKTOP_CHUNK_LENGTH)}`
      .slice(0, DESKTOP_MESSAGE_LIMIT),
  );
}

export function remoteDesktopErrorFields(error: unknown): RemoteDesktopDiagnosticFields {
  if (!error || typeof error !== "object") {
    return { error: bounded(String(error), 500) };
  }
  const record = error as Record<string, unknown>;
  const fields: RemoteDesktopDiagnosticFields = {};
  const name = bounded(record.name, 120);
  const message = bounded(record.message, 800);
  const stack = bounded(record.stack, 4_000);
  const code = bounded(record.code, 160);
  const requestId = bounded(record.requestId, 160);
  if (name) fields.name = name;
  if (message) fields.message = message;
  if (stack) fields.stack = stack;
  if (code) fields.code = code;
  if (requestId) fields.requestId = requestId;
  if (typeof record.status === "number" && Number.isFinite(record.status)) fields.status = record.status;
  return fields;
}

function defaultSink(entry: RemoteDesktopDiagnosticEntry) {
  const bridge = typeof window === "undefined"
    ? undefined
    : (window as Window & { taskHandoffDesktop?: { logBrowserDiagnostic?: (input: { message: string; instanceId?: string }) => void } }).taskHandoffDesktop;
  if (bridge?.logBrowserDiagnostic) {
    const instanceId = typeof entry.instanceId === "string" ? entry.instanceId : undefined;
    for (const message of formatRemoteDesktopDiagnosticMessages(entry)) {
      bridge.logBrowserDiagnostic({ message, ...(instanceId ? { instanceId } : {}) });
    }
    return;
  }
  console.warn("REMOTE_DESKTOP_DIAGNOSTIC", entry);
}

export function createRemoteDesktopDiagnostics(options: DiagnosticOptions) {
  const entries: RemoteDesktopDiagnosticEntry[] = [];
  const sink = options.sink ?? defaultSink;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  let sequence = 0;

  if (typeof globalThis !== "undefined") {
    (globalThis as typeof globalThis & { __taskHandoffRemoteDesktopDiagnostics?: RemoteDesktopDiagnosticEntry[] }).__taskHandoffRemoteDesktopDiagnostics = entries;
  }

  function record(event: string, fields: RemoteDesktopDiagnosticFields = {}) {
    if (!options.enabled()) return;
    try {
      const entry: RemoteDesktopDiagnosticEntry = {
        ...options.context(),
        ...fields,
        time: new Date().toISOString(),
        sequence: sequence += 1,
        event,
      };
      entries.push(entry);
      while (entries.length > maxEntries) entries.shift();
      sink(entry);
    } catch {
      // Diagnostics must never affect the remote-desktop state machine.
    }
  }

  return {
    record,
    snapshot: () => entries.slice(),
    clear: () => { entries.length = 0; },
  };
}
