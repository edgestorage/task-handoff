import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

export type DiagnosticLogLevel = 'info' | 'warn' | 'error';
export type DiagnosticLogData = Readonly<Record<string, unknown>>;

const STORAGE_KEY = 'task-handoff.mobile.diagnostic-logs';
const STORAGE_VERSION = 1;
const DIRECTORY_NAME = 'taskhandoff-diagnostics';
const LOG_NAME = 'mobile';
const MAX_LOG_BYTES = 512 * 1024;
const BACKUP_COUNT = 2;
export const RECENT_DIAGNOSTIC_LOG_BYTES = 256 * 1024;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LENGTH = 1_000;
const MAX_FATAL_STACK_LINES = 20;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(token|credential|secret|password|authorization|cookie|signature|proof|capability|nonce|challenge|verifier|grant|ticket)/i;
const SENSITIVE_ASSIGNMENT = /\b(token|credential|secret|password|authorization|cookie|signature|proof|capability|nonce|challenge|verifier|grant|ticket)=([^\s&;,]+)/gi;
const SENSITIVE_HEADER = /\b(authorization|cookie|x-api-key)\s*:\s*[^\s,;]+/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const DYNAMIC_ROUTE_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9]*_[a-z0-9_-]{6,}|[0-9a-f]{16,})$/i;

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type GlobalErrorUtils = {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
};

type DiagnosticLogState = { enabled: boolean };

const defaultEnabled = Constants.expoConfig?.extra?.variant === 'staging';

let state: DiagnosticLogState = { enabled: defaultEnabled };
let hydrated = false;
let mutated = false;
let hydration: Promise<void> | undefined;
let fatalHandlerInstalled = false;
let fatalContext: { appPhase?: string; route?: string } = {};
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function parseEnabled(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; enabled?: unknown };
    if (parsed?.version !== STORAGE_VERSION || typeof parsed.enabled !== 'boolean') return undefined;
    return parsed.enabled;
  } catch {
    return undefined;
  }
}

export function initializeDiagnosticLogs() {
  hydration ??= SecureStore.getItemAsync(STORAGE_KEY).then((raw) => {
    const enabled = parseEnabled(raw);
    if (enabled === undefined || mutated || state.enabled === enabled) return;
    state = { enabled };
    notify();
  }).catch(() => undefined).finally(() => { hydrated = true; });
  return hydration;
}

// Install this after the React Native runtime has created ErrorUtils, but before
// route modules start rendering. Fatal crashes do not always leave a React error
// boundary or a native crash message, so persist the JS error synchronously and
// then continue through the original handler unchanged.
export function installFatalErrorDiagnosticHandler() {
  if (fatalHandlerInstalled) return false;
  const errorUtils = (globalThis as typeof globalThis & { ErrorUtils?: GlobalErrorUtils }).ErrorUtils;
  if (!errorUtils) return false;
  try {
    const previousHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      if (isFatal) {
        try { writeDiagnosticLog('error', 'diagnostics.fatal', fatalErrorDetails(error, isFatal)); } catch { /* never mask the original crash */ }
      }
      previousHandler(error, isFatal);
    });
    fatalHandlerInstalled = true;
    diagnosticLog.info('diagnostics.fatal-handler.ready');
    return true;
  } catch {
    return false;
  }
}

export function diagnosticAppContext(): DiagnosticLogData {
  const extra = Constants.expoConfig?.extra;
  const cloudEnvironment = extra?.cloudEnvironment as { id?: unknown; serviceOrigin?: unknown } | undefined;
  return compactRecord({
    variant: typeof extra?.variant === 'string' ? extra.variant : undefined,
    appVersion: Constants.expoConfig?.version,
    buildNumber: typeof Constants.expoConfig?.ios?.buildNumber === 'string' ? Constants.expoConfig.ios.buildNumber : undefined,
    cloudEnvironment: typeof cloudEnvironment?.id === 'string' ? cloudEnvironment.id : undefined,
    cloudServiceOrigin: typeof cloudEnvironment?.serviceOrigin === 'string'
      ? cloudEnvironment.serviceOrigin
      : typeof extra?.cloudServiceOrigin === 'string' ? extra.cloudServiceOrigin : undefined,
  });
}

export function diagnosticRouteLabel(pathname: string) {
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').filter(Boolean).filter((segment) => !segment.startsWith('('));
  if (segments.length === 0) return '/';
  return `/${segments.map((segment, index) => index > 0 && DYNAMIC_ROUTE_SEGMENT.test(segment) ? ':id' : segment).join('/')}`;
}

export function setDiagnosticRoute(pathname: string) {
  fatalContext = { ...fatalContext, route: diagnosticRouteLabel(pathname) };
  diagnosticLog.info('navigation.route', { route: fatalContext.route });
}

export function setDiagnosticAppPhase(phase: string) {
  fatalContext = { ...fatalContext, appPhase: phase };
  diagnosticLog.info('app.phase', { phase });
}

export function getDiagnosticLogsEnabled() {
  return state.enabled;
}

export function subscribeDiagnosticLogs(listener: () => void) {
  listeners.add(listener);
  void initializeDiagnosticLogs();
  return () => { listeners.delete(listener); };
}

export function setDiagnosticLogsEnabled(enabled: boolean) {
  if (state.enabled === enabled && (hydrated || mutated)) return;
  const previous = state.enabled;
  mutated = true;
  if (previous && !enabled) writeDiagnosticEntry('info', 'diagnostics.disabled');
  state = { enabled };
  notify();
  if (!previous && enabled) writeDiagnosticEntry('info', 'diagnostics.enabled', { maxLogBytes: MAX_LOG_BYTES, backupCount: BACKUP_COUNT });
  void SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, enabled })).catch(() => undefined);
}

export function writeDiagnosticLog(level: DiagnosticLogLevel, event: string, data?: DiagnosticLogData) {
  if (!state.enabled) return;
  writeDiagnosticEntry(level, event, data);
}

export const diagnosticLog = {
  info: (event: string, data?: DiagnosticLogData) => writeDiagnosticLog('info', event, data),
  warn: (event: string, data?: DiagnosticLogData) => writeDiagnosticLog('warn', event, data),
  error: (event: string, data?: DiagnosticLogData) => writeDiagnosticLog('error', event, data),
};

export function diagnosticErrorDetails(error: unknown): DiagnosticLogData {
  if (error === undefined || error === null) return {};
  if (error instanceof Error) {
    const value = error as Error & { code?: unknown; status?: unknown; retryable?: unknown; socketDomain?: unknown; socketCode?: unknown };
    return {
      errorName: value.name,
      errorMessage: value.message,
      ...(typeof value.code === 'string' ? { errorCode: value.code } : {}),
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
      ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      ...closeDetails(value),
      ...nativeSocketDetails(value),
    };
  }
  if (typeof error === 'object') {
    const value = error as { code?: unknown; status?: unknown; retryable?: unknown; message?: unknown; relayCloseCode?: unknown; relayCloseReason?: unknown; socketDomain?: unknown; socketCode?: unknown };
    return {
      ...(typeof value.code === 'string' ? { errorCode: value.code } : {}),
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
      ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
      ...(typeof value.message === 'string' ? { errorMessage: value.message } : {}),
      ...closeDetails(value),
      ...nativeSocketDetails(value),
    };
  }
  return { errorMessage: String(error) };
}

function closeDetails(source: object) {
  const value = source as { relayCloseCode?: unknown; relayCloseReason?: unknown };
  return {
    ...(typeof value.relayCloseCode === 'number' && Number.isFinite(value.relayCloseCode) ? { relayCloseCode: value.relayCloseCode } : {}),
    ...(typeof value.relayCloseReason === 'string' && value.relayCloseReason ? { relayCloseReason: value.relayCloseReason } : {}),
  };
}

function nativeSocketDetails(source: object) {
  const value = source as { socketDomain?: unknown; socketCode?: unknown };
  return {
    ...(typeof value.socketDomain === 'string' && value.socketDomain ? { socketDomain: value.socketDomain } : {}),
    ...(typeof value.socketCode === 'number' && Number.isFinite(value.socketCode) ? { socketCode: value.socketCode } : {}),
  };
}

export async function getRecentDiagnosticLogs(maxBytes = RECENT_DIAGNOSTIC_LOG_BYTES) {
  const directory = logDirectory();
  if (!directory.exists) return '';
  const chunks: string[] = [];
  for (const file of orderedLogFiles(directory)) {
    if (!file.exists) continue;
    try { chunks.push(await file.text()); } catch { /* one unreadable file must not hide the others */ }
  }
  const content = chunks.join('');
  if (content.length <= maxBytes) return content;
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= maxBytes) return content;
  let tail = bytes.slice(bytes.length - maxBytes);
  const newline = tail.indexOf(10);
  if (newline >= 0) tail = tail.slice(newline + 1);
  return new TextDecoder().decode(tail);
}

export async function copyRecentDiagnosticLogs(maxBytes = RECENT_DIAGNOSTIC_LOG_BYTES) {
  const content = await getRecentDiagnosticLogs(maxBytes);
  if (!content) return 0;
  await Clipboard.setStringAsync(content);
  return content.length;
}

export async function clearDiagnosticLogs() {
  const directory = logDirectory();
  if (!directory.exists) return;
  for (const file of orderedLogFiles(directory)) {
    try { if (file.exists) file.delete(); } catch { /* clearing is best effort */ }
  }
}

function writeDiagnosticEntry(level: DiagnosticLogLevel, event: string, data?: DiagnosticLogData) {
  let line: string;
  try {
    line = `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      source: 'mobile',
      ...(data === undefined ? {} : { data: sanitizeValue(data, 0, new WeakSet()) }),
    })}\n`;
  } catch {
    return;
  }
  try {
    const directory = logDirectory();
    directory.create({ idempotent: true, intermediates: true });
    let file = logFile(directory, 0);
    if (file.exists && file.size + line.length > MAX_LOG_BYTES) {
      rotate(directory);
      file = logFile(directory, 0);
    }
    if (!file.exists) file.create();
    file.write(line, { append: true });
  } catch {
    // Diagnostics must never affect networking or app behavior.
  }
}

function fatalErrorDetails(error: unknown, isFatal: boolean): DiagnosticLogData {
  const details = diagnosticErrorDetails(error);
  const stack = error instanceof Error && typeof error.stack === 'string'
    ? error.stack.split('\n').slice(0, MAX_FATAL_STACK_LINES).map((line) => redactDiagnosticText(line)).filter(Boolean)
    : undefined;
  return {
    ...details,
    ...(typeof details.errorMessage === 'string' ? { errorMessage: redactDiagnosticText(details.errorMessage) } : {}),
    ...(stack?.length ? { errorStack: stack } : {}),
    ...fatalContext,
    isFatal,
  };
}

function redactDiagnosticText(value: string) {
  return value
    .replace(SENSITIVE_ASSIGNMENT, '$1=[REDACTED]')
    .replace(SENSITIVE_HEADER, '$1: [REDACTED]')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]');
}

function compactRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function rotate(directory: Directory) {
  for (let index = BACKUP_COUNT; index >= 1; index -= 1) {
    const destination = logFile(directory, index);
    if (destination.exists) destination.delete();
    const source = logFile(directory, index - 1);
    if (source.exists) source.moveSync(destination, { overwrite: true });
  }
}

function logDirectory() {
  return new Directory(Paths.document, DIRECTORY_NAME);
}

function logFile(directory: Directory, index: number) {
  return new File(directory, index === 0 ? `${LOG_NAME}.log` : `${LOG_NAME}.${index}.log`);
}

function orderedLogFiles(directory: Directory) {
  return Array.from({ length: BACKUP_COUNT + 1 }, (_value, offset) => logFile(directory, BACKUP_COUNT - offset));
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}[truncated]` : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[Unsupported]';
  if (value instanceof Uint8Array) return `[bytes:${value.length}]`;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Error) {
    return sanitizeValue({
      name: value.name,
      message: value.message,
      code: (value as Error & { code?: unknown }).code,
      status: (value as Error & { status?: unknown }).status,
      retryable: (value as Error & { retryable?: unknown }).retryable,
    }, depth + 1, seen);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`);
      return items;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count >= MAX_OBJECT_KEYS) { result._truncated = true; break; }
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
      count += 1;
    }
    return result;
  }
  return String(value);
}
