import { claudeControlSock, killClaudeDaemonJob, listClaudeDaemonJobs, replyClaudeDaemonJob, subscribeClaudeDaemonJob, type ClaudeDaemonJob } from "@task-handoff/core/core/claude-control-sock";
import { CONFIG_PATH } from "@task-handoff/core/core/persistence";
import { appendJsonl, defaultDiagnosticLogPath } from "@task-handoff/core/core/diagnostics";
import { findClaudeTranscriptPath } from "@task-handoff/core/core/transcript";
import type { AiSessionLifecycle, AiSessionPhase, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision, AiSessionControlProvider, AiSessionSendInput } from "./ai-session-control";
import { aiSessionControlError } from "./ai-session-control";
import { withAttachmentPathFallback } from "./ai-session-attachments";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";

type ClaudeAppSession = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  launch?: {
    cwd?: unknown;
  };
  tty?: {
    cwd?: unknown;
  };
  ai?: {
    claude?: {
      short?: unknown;
      controlSock?: unknown;
      providerSessionId?: unknown;
      pid?: unknown;
      cwd?: unknown;
      state?: unknown;
      tempo?: unknown;
      cliVersion?: unknown;
      source?: unknown;
    };
  };
};

type ClaudeControlClientLike = {
  list: () => Promise<{ ok?: boolean; jobs?: ClaudeDaemonJob[]; error?: string; code?: string }>;
  reply: (short: string, text: string, options?: { sockPath?: string; timeoutMs?: number }) => Promise<{ ok?: boolean; error?: string; code?: string }>;
  kill: (short: string, signal?: string, options?: { sockPath?: string; timeoutMs?: number }) => Promise<{ ok?: boolean; error?: string; code?: string }>;
  subscribe: (
    short: string,
    input: {
      tail?: number;
      onMessage?: (message: Record<string, unknown>) => void;
      options?: { sockPath?: string; timeoutMs?: number };
    },
  ) => () => void;
};

const CLAUDE_CONTROL_SOCK_LOG_PATH =
  process.env.TASK_HANDOFF_CLAUDE_CONTROL_SOCK_LOG ||
  (process.env.TASK_HANDOFF_LOG_DIR ? `${process.env.TASK_HANDOFF_LOG_DIR}/claude-control-sock.log` : undefined) ||
  defaultDiagnosticLogPath(CONFIG_PATH, "claude-control-sock.log");

export class ClaudeControlSockSessionBridge implements AiSessionControlProvider, AiSessionDiscoveryProvider {
  readonly id = "claude-control-sock";
  readonly agent = "claude";
  private readonly subscriptions = new Map<string, () => void>();
  private readonly textByShort = new Map<string, string>();

  constructor(
    private readonly registry: AiSessionRegistry,
    private readonly client: ClaudeControlClientLike = {
      list: () => listClaudeDaemonJobs({ timeoutMs: Number(process.env.TASK_HANDOFF_CLAUDE_CONTROL_TIMEOUT_MS) || 5000 }),
      reply: replyClaudeDaemonJob,
      kill: killClaudeDaemonJob,
      subscribe: subscribeClaudeDaemonJob,
    },
  ) {}

  async refresh(context: AiSessionDiscoveryContext) {
    if (!envFlag("TASK_HANDOFF_AI_SESSION_SCAN", true) || !envFlag("TASK_HANDOFF_CLAUDE_CONTROL_SCAN", true)) {
      return;
    }
    const response = await this.client.list();
    const jobs = response.ok && Array.isArray(response.jobs) ? response.jobs : [];
    const appSessions = (context.appSessions as ClaudeAppSession[]).filter(isRunningAppSession);
    const sessionsByShort = new Map<string, ClaudeAppSession>();
    for (const appSession of appSessions) {
      const short = compact(appSession.ai?.claude?.short, 80);
      if (short) {
        sessionsByShort.set(short, appSession);
      }
    }
    for (const appSession of appSessions) {
      const short = compact(appSession.ai?.claude?.short, 80);
      if (!short) {
        continue;
      }
      const job = jobs.find((entry) => entry.short === short);
      this.upsertJob(job || claudeJobFromAppSession(appSession) || { short }, appSession);
    }
    for (const job of jobs) {
      if (!job.short || sessionsByShort.has(job.short)) {
        continue;
      }
      this.upsertJob(job);
    }
    this.reconcileSubscriptions(new Set([
      ...jobs.map((job) => compact(job.short, 80)).filter(Boolean),
      ...Array.from(sessionsByShort.keys()),
    ]));
    context.registry.reconcileAdapterSessions({
      agent: this.agent,
      appSessionIds: new Set(appSessions.map((session) => compact(session.id, 120)).filter(Boolean)),
      providerSessionIds: new Set(jobs.map((job) => compact(job.sessionId, 240)).filter(Boolean)),
      providerShorts: new Set([
        ...jobs.map((job) => compact(job.short, 80)).filter(Boolean),
        ...Array.from(sessionsByShort.keys()),
      ]),
    });
  }

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.startMessage(session, input);
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const short = this.requireShort(session);
    const response = await withAttachmentPathFallback(input.message, input.attachments, (providerMessage) => this.client.reply(
      short,
      providerMessage.endsWith("\n") ? providerMessage : `${providerMessage}\n`,
      {
        sockPath: this.controlSockForSession(session),
        timeoutMs: Number(process.env.TASK_HANDOFF_CLAUDE_CONTROL_TIMEOUT_MS) || 5000,
      },
    ));
    if (!response.ok) {
      throw aiSessionControlError("AI_SESSION_SEND_FAILED", response.error || `Claude reply failed: ${response.code || "unknown"}`);
    }
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "send-ack",
      userPrompt: input.message,
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: "send", turnId: updated.activeTurnId };
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    const result = await this.startMessage(session, input);
    return { ...result, action: "steer" };
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    const short = this.requireShort(session);
    const response = await this.client.kill(short, "SIGTERM", {
      sockPath: this.controlSockForSession(session),
      timeoutMs: Number(process.env.TASK_HANDOFF_CLAUDE_CONTROL_TIMEOUT_MS) || 5000,
    });
    if (!response.ok) {
      throw aiSessionControlError("AI_SESSION_INTERRUPT_FAILED", response.error || `Claude interrupt failed: ${response.code || "unknown"}`);
    }
    const updated = this.registry.applyRealtimeEvent(session.id, {
      kind: "lifecycle",
      status: "running",
      phase: "unknown",
      source: "control",
    }) || session;
    return { session: updated, provider: this.agent, action: "interrupt" };
  }

  async resolveApproval(_session: AiSessionStatus, _decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    throw aiSessionControlError("AI_SESSION_APPROVAL_UNSUPPORTED", "Claude daemon sessions do not expose structured approval control.", 400);
  }

  stop() {
    for (const stop of this.subscriptions.values()) {
      stop();
    }
    this.subscriptions.clear();
    this.textByShort.clear();
  }

  private upsertJob(job: Partial<ClaudeDaemonJob>, appSession?: ClaudeAppSession) {
    const short = compact(job.short, 80);
    if (!short) {
      return;
    }
    const providerSessionId = compact(job.sessionId || appSession?.ai?.claude?.providerSessionId, 240);
    const cwd = compact(job.cwd || appSession?.ai?.claude?.cwd || appSession?.tty?.cwd || appSession?.launch?.cwd, 4096);
    const existing = this.sessionForShort(short);
    const lifecycle = claudeLifecycle(job.state || appSession?.ai?.claude?.state, {
      hasWorkSignal: hasClaudeWorkSignal(job),
      isAppSession: Boolean(appSession || existing?.appSessionId),
    });
    const controlSock = compact(appSession?.ai?.claude?.controlSock, 4096) || claudeControlSock();
    const session = this.registry.applyAdapterSnapshot({
      source: "adapter-snapshot",
      agent: "claude",
      appId: compact(appSession?.appId, 120) || (appSession ? "claude" : "claude-daemon"),
      appSessionId: compact(appSession?.id, 120),
      providerSessionId,
      appBindingKeys: claudeAppBindingKeys(appSession, short),
      actions: claudeActions(lifecycle),
      providerMeta: {
        short,
        controlSock,
        pid: Number(job.pid || appSession?.ai?.claude?.pid) || undefined,
        state: compact(job.state || appSession?.ai?.claude?.state, 80),
        tempo: compact(job.tempo || appSession?.ai?.claude?.tempo, 80),
        cliVersion: compact(job.cliVersion || appSession?.ai?.claude?.cliVersion, 80),
        source: compact(job.source || appSession?.ai?.claude?.source, 80),
      },
      title: compact(appSession?.title, 240) || "Claude",
      cwd,
      transcriptPath: findClaudeTranscriptPath(providerSessionId, cwd),
      status: lifecycle.status,
      phase: lifecycle.phase,
    });
    if (session) {
      this.ensureSubscription(short, controlSock);
    }
  }

  private reconcileSubscriptions(activeShorts: Set<string>) {
    for (const [short, stop] of this.subscriptions) {
      if (!activeShorts.has(short)) {
        stop();
        this.subscriptions.delete(short);
        this.textByShort.delete(short);
      }
    }
  }

  private ensureSubscription(short: string, controlSock: string) {
    if (this.subscriptions.has(short)) {
      return;
    }
    this.subscriptions.set(short, () => {});
    const stop = this.client.subscribe(short, {
      tail: Number(process.env.TASK_HANDOFF_CLAUDE_SUBSCRIBE_TAIL_BYTES) || 4096,
      options: { sockPath: controlSock },
      onMessage: (message) => this.applySubscribeMessage(short, controlSock, message),
    });
    this.subscriptions.set(short, stop);
  }

  private applySubscribeMessage(short: string, controlSock: string, message: Record<string, unknown>) {
    const record = objectValue(message.record);
    if (record) {
      this.upsertJob(record as Partial<ClaudeDaemonJob>);
    }
    const text = this.textFromSubscribeMessage(short, message);
    if (text) {
      const session = this.sessionForShort(short);
      if (session) {
        this.registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text, source: "realtime" });
      }
    }
    const stateInfo = this.stateFromSubscribeMessage(message, record);
    if (stateInfo.observedState) {
      const session = this.sessionForShort(short);
      const lifecycle = stateInfo.lifecycleState
        ? claudeLifecycle(stateInfo.lifecycleState, {
            hasWorkSignal: false,
            isAppSession: Boolean(session?.appSessionId),
          })
        : undefined;
      this.logSubscribeMessage(short, controlSock, message, record, stateInfo, session, lifecycle);
      if (session) {
        this.registry.applyAdapterSnapshot({
          source: "adapter-snapshot",
          agent: session.agent,
          appId: session.appId,
          appSessionId: session.appSessionId,
          providerSessionId: session.providerSessionId,
          appBindingKeys: session.appBindingKeys,
          actions: claudeActions(lifecycle),
          providerMeta: { ...(session.providerMeta || {}), short, controlSock, state: stateInfo.observedState, stateSource: stateInfo.source },
          status: lifecycle?.status,
          phase: lifecycle?.phase,
          cwd: session.cwd,
          title: session.title,
        });
      }
    } else {
      this.logSubscribeMessage(short, controlSock, message, record, stateInfo, this.sessionForShort(short));
    }
  }

  private sessionForShort(short: string) {
    return this.registry.list().find((session) => session.agent === "claude" && session.providerMeta?.short === short);
  }

  private stateFromSubscribeMessage(message: Record<string, unknown>, record?: Record<string, unknown>) {
    const patch = objectValue(message.patch);
    const settledOutcome = compact(message.type, 80) === "settled" ? message.outcome : undefined;
    const candidates = [
      { source: "message.state", value: message.state },
      { source: "patch.state", value: patch?.state },
      { source: "record.state", value: record?.state },
      { source: "settled.outcome", value: settledOutcome },
    ];
    const candidate = candidates.find((item) => compact(item.value, 80));
    const observedState = compact(candidate?.value, 80);
    const lifecycleState = compact(settledOutcome, 80);
    return {
      observedState,
      lifecycleState,
      source: candidate?.source,
      patch,
    };
  }

  private logSubscribeMessage(
    short: string,
    controlSock: string,
    message: Record<string, unknown>,
    record: Record<string, unknown> | undefined,
    stateInfo: { observedState: string; lifecycleState: string; source?: string; patch?: Record<string, unknown> },
    session?: AiSessionStatus,
    lifecycle?: { status: AiSessionLifecycle; phase: AiSessionPhase },
  ) {
    if (!envFlag("TASK_HANDOFF_DIAGNOSTIC_LOGS")) {
      return;
    }
    try {
      appendJsonl(CLAUDE_CONTROL_SOCK_LOG_PATH, {
        event: "claude_control_subscribe",
        short,
        controlSock,
        messageType: compact(message.type, 80) || undefined,
        state: stateInfo.observedState || undefined,
        lifecycleState: stateInfo.lifecycleState || undefined,
        stateSource: stateInfo.source,
        recordState: compact(record?.state, 80) || undefined,
        patchKeys: stateInfo.patch ? Object.keys(stateInfo.patch).sort() : undefined,
        outcome: compact(message.outcome, 80) || undefined,
        streamLineBytes: typeof message.line === "string" ? Buffer.byteLength(message.line) : undefined,
        streamTailCount: arrayValue(message.streamTail).length || undefined,
        aiSessionId: session?.id,
        appSessionId: session?.appSessionId,
        providerSessionId: session?.providerSessionId,
        mappedStatus: lifecycle?.status,
        mappedPhase: lifecycle?.phase,
      });
    } catch {
      // Diagnostics are best-effort.
    }
  }

  private textFromSubscribeMessage(short: string, message: Record<string, unknown>) {
    const chunks = [
      ...arrayValue(message.streamTail).map((value) => String(value || "")),
      ...arrayValue(message.output).map((value) => String(value || "")),
      stringValue(message.data),
      stringValue(message.text),
      stringValue(message.delta),
      stringValue(message.raw),
    ].filter(Boolean);
    if (chunks.length === 0) {
      return "";
    }
    const clean = stripAnsi(chunks.join("\n"))
      .replace(/\u0007/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isClaudeStartupChromeLine(line))
      .slice(-8)
      .join("\n")
      .trim();
    if (!clean || this.textByShort.get(short) === clean) {
      return "";
    }
    this.textByShort.set(short, clean);
    return clean;
  }

  private requireShort(session: AiSessionStatus) {
    const short = typeof session.providerMeta?.short === "string" ? session.providerMeta.short : undefined;
    if (!short) {
      throw aiSessionControlError("AI_SESSION_CLAUDE_SHORT_NOT_FOUND", "Claude session is not bound to a daemon worker.");
    }
    return short;
  }

  private controlSockForSession(session: AiSessionStatus) {
    return typeof session.providerMeta?.controlSock === "string" ? session.providerMeta.controlSock : undefined;
  }
}

function claudeLifecycle(value: unknown, options: { hasWorkSignal?: boolean; isAppSession?: boolean } = {}): { status: AiSessionLifecycle; phase: AiSessionPhase } {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "idle") {
    return { status: "idle", phase: "unknown" };
  }
  if (normalized === "blocked") {
    return { status: "idle", phase: "unknown" };
  }
  if (normalized === "waiting") {
    return { status: "waiting", phase: "unknown" };
  }
  if (normalized === "failed") {
    return { status: "failed", phase: "unknown" };
  }
  if (["stopped", "exited", "completed", "done"].includes(normalized)) {
    return { status: "idle", phase: "unknown" };
  }
  if (["active", "busy", "running", "thinking", "working"].includes(normalized)) {
    if (options.isAppSession && !options.hasWorkSignal) {
      return { status: "idle", phase: "unknown" };
    }
    return { status: "running", phase: "thinking" };
  }
  return { status: "idle", phase: "unknown" };
}

function claudeActions(lifecycle?: { status: AiSessionLifecycle }) {
  const active = lifecycle?.status === "running" || lifecycle?.status === "waiting";
  return {
    send: true,
    interrupt: active,
    approval: false,
  };
}

function hasClaudeWorkSignal(job: Partial<ClaudeDaemonJob>) {
  return Boolean(compact(job.detail, 500) || compact(job.intent, 500) || compact((job as { needs?: unknown }).needs, 500));
}

function compact(value: unknown, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stripAnsi(value: unknown) {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)?/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\x1B[\x30-\x7E]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function isClaudeStartupChromeLine(line: string) {
  const normalized = line
    .replace(/[─━═_\-]{3,}/g, "")
    .replace(/[⏺●•·]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return true;
  }
  return [
    /^claude code\b/i,
    /\bapi usage billing\b/i,
    /\/effort\b/i,
    /\bauto mode on\b/i,
    /\bshift\+tab to cycle\b/i,
    /\bfor agents\b/i,
    /^log an error\??"?$/i,
    /^~\/\S+/,
    /^\S+\s+·\s+\S+.*\b\/project\/work\b/i,
    /^\S+\s+·\s+\/?(?:workspace|project|Users|home)\b/i,
    /^(?:high|medium|low)\s*·\s*\/?effort\b/i,
    /^[›>]\s*try\s+["'`]/i,
    /^try\s+["'`]/i,
  ].some((pattern) => pattern.test(normalized));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function envFlag(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function claudeJobFromAppSession(appSession: ClaudeAppSession): Partial<ClaudeDaemonJob> | undefined {
  const claude = appSession.ai?.claude;
  const short = compact(claude?.short, 80);
  if (!short) {
    return undefined;
  }
  return {
    short,
    sessionId: compact(claude?.providerSessionId, 240) || undefined,
    pid: Number(claude?.pid) || undefined,
    cwd: compact(claude?.cwd || appSession.tty?.cwd || appSession.launch?.cwd, 4096) || undefined,
    state: compact(claude?.state, 80) || undefined,
    tempo: compact(claude?.tempo, 80) || undefined,
    cliVersion: compact(claude?.cliVersion, 80) || undefined,
    source: compact(claude?.source, 80) || undefined,
  };
}

function claudeAppBindingKeys(appSession: ClaudeAppSession | undefined, short: string) {
  const keys = [
    appSession?.id ? `app:${compact(appSession.id, 120)}` : "",
    short ? `claude-short:${short}` : "",
  ].filter(Boolean);
  return keys.length ? keys : undefined;
}

function isRunningAppSession(appSession: ClaudeAppSession) {
  const status = compact(appSession.status, 80).toLowerCase();
  return !status || status === "running";
}
