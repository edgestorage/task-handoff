type UnknownRecord = Record<string, unknown>;

/**
 * The app-session snapshot is runtime data and may have been written by a
 * different version. Keep its boundary permissive and inspect only the fields
 * needed by the Codex binding policy.
 */
export type CodexAppSession = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  createdAt?: unknown;
  launch?: unknown;
  tty?: unknown;
  ai?: unknown;
  [key: string]: unknown;
};

type BindingSession = {
  id?: string;
  appId?: string;
  status?: string;
  transport?: string;
  endpoint?: string;
  socketPath?: string;
  tokenFile?: string;
  command?: string;
  activeThreadId?: string;
  threadIds: readonly string[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function bindingSession(value: unknown): BindingSession | undefined {
  if (!isRecord(value)) return undefined;

  const ai = isRecord(value.ai) ? value.ai : undefined;
  const appServer = ai && isRecord(ai.appServer) ? ai.appServer : undefined;
  const socketPath = nonEmptyString(appServer?.socketPath);
  const endpoint = nonEmptyString(appServer?.endpoint);
  // Endpoint shape predates transport, so a unix endpoint without an explicit
  // transport is still a unix endpoint.
  const transport = nonEmptyString(appServer?.transport) ?? (socketPath ? "unix" : endpoint ? "ws" : undefined);
  return {
    id: nonEmptyString(value.id),
    appId: typeof value.appId === "string" ? value.appId : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    transport,
    endpoint,
    socketPath,
    tokenFile: nonEmptyString(appServer?.tokenFile),
    command: nonEmptyString(appServer?.command),
    activeThreadId: typeof ai?.activeThreadId === "string" ? ai.activeThreadId : undefined,
    threadIds: Array.isArray(ai?.threadIds)
      ? ai.threadIds.filter((threadId): threadId is string => typeof threadId === "string")
      : [],
  };
}

function isRunningCodexSession(session: BindingSession) {
  return session.appId === "codex" && session.status === "running" && codexAppServerTargetFor(session) !== undefined;
}

function codexAppServerTargetFor(session: BindingSession) {
  if (session.transport === "ws") {
    return session.endpoint
      ? { transport: "ws" as const, endpoint: session.endpoint, ...(session.tokenFile ? { tokenFile: session.tokenFile } : {}) }
      : undefined;
  }
  return session.socketPath ? { transport: "unix" as const, socketPath: session.socketPath } : undefined;
}

export function codexAppServerTarget(appSessions: readonly unknown[]) {
  for (const value of appSessions) {
    const session = bindingSession(value);
    if (!session || !isRunningCodexSession(session)) continue;
    const target = codexAppServerTargetFor(session);
    if (target) return target;
  }
  return undefined;
}

/** AF_UNIX endpoints only; kept for callers that only understand sockets. */
export function codexAppServerSocketPath(appSessions: readonly unknown[]) {
  const target = codexAppServerTarget(appSessions);
  return target?.transport === "unix" ? target.socketPath : undefined;
}

/** Owns the latest app-session snapshot and the thread-to-app binding policy. */
export class CodexAppServerSessionBinding {
  private sessions: readonly BindingSession[] = [];
  private targetValue?: ReturnType<typeof codexAppServerTarget>;
  private commandValue?: string;

  get target() {
    return this.targetValue;
  }

  /** Stable identity for the selected endpoint. */
  get targetKey() {
    const target = this.targetValue;
    if (!target) return "";
    return target.transport === "unix" ? `unix:${target.socketPath}` : `ws:${target.endpoint}:${target.tokenFile ?? ""}`;
  }

  get socketPath() {
    const target = this.targetValue;
    return target?.transport === "unix" ? target.socketPath : undefined;
  }

  get command() {
    return this.commandValue;
  }

  update(appSessions: readonly unknown[] = []) {
    this.sessions = appSessions.flatMap((value) => {
      const session = bindingSession(value);
      return session ? [session] : [];
    });
    const activeSession = this.sessions.find(isRunningCodexSession);
    this.targetValue = activeSession ? codexAppServerTargetFor(activeSession) : undefined;
    this.commandValue = activeSession?.command;
    return this.targetValue;
  }

  clear() {
    this.sessions = [];
    this.targetValue = undefined;
    this.commandValue = undefined;
  }

  appSessionIdForThread(threadId: string) {
    const targetKey = this.targetKey;
    if (!targetKey) return undefined;

    for (const session of this.sessions) {
      if (!session.id || !isRunningCodexSession(session)) continue;
      const target = codexAppServerTargetFor(session);
      if (!target) continue;
      const key = target.transport === "unix" ? `unix:${target.socketPath}` : `ws:${target.endpoint}:${target.tokenFile ?? ""}`;
      if (key !== targetKey) continue;
      if (session.activeThreadId === threadId || session.threadIds.includes(threadId)) return session.id;
    }
    return undefined;
  }
}
