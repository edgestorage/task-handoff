import { diagnosticLog, type DiagnosticLogData } from '../observability/diagnostic-logs';

let sequence = 0;

/** Local diagnostics only. Never include URLs, tokens, or transport payloads. */
export async function traceBrowserTask<T>(
  event: string,
  data: DiagnosticLogData,
  task: (spanId: string) => Promise<T>,
): Promise<T> {
  const spanId = `browser_${Date.now().toString(36)}_${++sequence}`;
  const startedAt = performance.now();
  const context = { ...data, spanId };
  const durationMs = () => Math.round(performance.now() - startedAt);
  diagnosticLog.info(`${event}.start`, context);
  // A single diagnostic deadline, not a retry, polling loop, or state change.
  const timer = setTimeout(() => diagnosticLog.warn(`${event}.waiting`, { ...context, durationMs: durationMs() }), 10_000);
  try {
    const result = await task(spanId);
    diagnosticLog.info(`${event}.end`, { ...context, durationMs: durationMs(), outcome: 'completed' });
    return result;
  } catch (cause) {
    diagnosticLog.warn(`${event}.end`, { ...context, durationMs: durationMs(), outcome: 'failed', ...browserErrorDiagnostic(cause) });
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export function browserErrorDiagnostic(cause: unknown): DiagnosticLogData {
  // Messages can contain URLs, response bodies, and credentials. Codes describe
  // the failure without copying data from the browser or an untrusted peer.
  const error = cause as { name?: unknown; code?: unknown; status?: unknown; closeSource?: unknown; nativeErrorDomain?: unknown; nativeErrorCode?: unknown } | undefined;
  return {
    ...(typeof error?.name === 'string' ? { errorName: error.name } : {}),
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    ...(typeof error?.closeSource === 'string' ? { closeSource: error.closeSource } : {}),
    ...(typeof error?.nativeErrorDomain === 'string' ? { nativeErrorDomain: error.nativeErrorDomain } : {}),
    ...(typeof error?.nativeErrorCode === 'number' ? { nativeErrorCode: error.nativeErrorCode } : {}),
  };
}
