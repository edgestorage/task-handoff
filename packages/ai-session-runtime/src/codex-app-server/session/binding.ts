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
  socketPath?: string;
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
  return {
    id: nonEmptyString(value.id),
    appId: typeof value.appId === "string" ? value.appId : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    socketPath: nonEmptyString(appServer?.socketPath),
    command: nonEmptyString(appServer?.command),
    activeThreadId: typeof ai?.activeThreadId === "string" ? ai.activeThreadId : undefined,
    threadIds: Array.isArray(ai?.threadIds)
      ? ai.threadIds.filter((threadId): threadId is string => typeof threadId === "string")
      : [],
  };
}

function isRunningCodexSession(session: BindingSession) {
  return session.appId === "codex" && session.status === "running" && session.socketPath !== undefined;
}

export function codexAppServerSocketPath(appSessions: readonly unknown[]) {
  for (const value of appSessions) {
    const session = bindingSession(value);
    if (session && isRunningCodexSession(session)) return session.socketPath;
  }
  return undefined;
}

/** Owns the latest app-session snapshot and the thread-to-app binding policy. */
export class CodexAppServerSessionBinding {
  private sessions: readonly BindingSession[] = [];
  private socketPathValue?: string;
  private commandValue?: string;

  get socketPath() {
    return this.socketPathValue;
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
    this.socketPathValue = activeSession?.socketPath;
    this.commandValue = activeSession?.command;
    return this.socketPathValue;
  }

  clear() {
    this.sessions = [];
    this.socketPathValue = undefined;
    this.commandValue = undefined;
  }

  appSessionIdForThread(threadId: string) {
    const socketPath = this.socketPathValue;
    if (!socketPath) return undefined;

    for (const session of this.sessions) {
      if (!session.id || !isRunningCodexSession(session) || session.socketPath !== socketPath) continue;
      if (session.activeThreadId === threadId || session.threadIds.includes(threadId)) return session.id;
    }
    return undefined;
  }
}
