import { diagnosticLog, type DiagnosticLogData } from './diagnostic-logs';

let sequence = 0;

/** Local spans only: never send timing metadata in business models or payloads. */
export async function traceDiagnosticTask<T>(
  event: string,
  data: DiagnosticLogData,
  task: (spanId: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const spanId = `span_${Date.now().toString(36)}_${++sequence}`;
  const startedAt = performance.now();
  const context = { ...data, spanId };
  diagnosticLog.info(`${event}.start`, context);
  try {
    const result = await task(spanId);
    diagnosticLog.info(`${event}.end`, {
      ...context, durationMs: Math.round(performance.now() - startedAt),
      outcome: signal?.aborted ? 'aborted' : 'completed',
    });
    return result;
  } catch (cause) {
    // Error messages can include response bodies or URLs. Keep only the outcome.
    diagnosticLog.warn(`${event}.end`, {
      ...context, durationMs: Math.round(performance.now() - startedAt),
      outcome: signal?.aborted ? 'aborted' : 'failed',
    });
    throw cause;
  }
}
