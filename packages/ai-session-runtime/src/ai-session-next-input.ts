import {
  AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT,
  AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS,
  resolveAiSessionNextInputSuggestionReasoningEffort,
} from "@task-handoff/protocol/ai-sessions";
import type {
  AiSessionNextInputSuggestion,
  AiSessionNextInputSuggestionReasoningEffort,
  AiSessionReasoningEffort,
  AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import type { AiSessionRegistry } from "./ai-session-registry";

export const AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES = 8 * 1024;
export const AI_SESSION_NEXT_INPUT_RESPONSE_MAX_BYTES = 64 * 1024;
export const AI_SESSION_NEXT_INPUT_REQUEST_TIMEOUT_MS = 30_000;
export const AI_SESSION_NEXT_INPUT_DEBOUNCE_MS = 1_000;
const MAX_TRACKED_SUGGESTION_KEYS = 5_000;
export const AI_SESSION_NEXT_INPUT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestion"],
  properties: {
    suggestion: {
      type: "string",
      description: "A concise single-line next user message in the same language as the latest user message.",
    },
  },
} as const;

type ContextTurn = {
  user: string;
  assistant: string;
};

function compactText(value: string | undefined) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function turnUserText(turn: NonNullable<AiSessionStatus["turns"]>[number]) {
  const latestUserMessage = [...(turn.userMessages || [])]
    .reverse()
    .find((message) => message.text.trim())?.text;
  return compactText(latestUserMessage || turn.userPrompt);
}

function turnAssistantText(turn: NonNullable<AiSessionStatus["turns"]>[number]) {
  return compactText(turn.lastMessage || turn.summary);
}

export function truncateAiSessionNextInputUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let used = 0;
  let output = "";
  for (const character of Array.from(value)) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

export function aiSessionNextInputContext(session: AiSessionStatus, maxBytes = AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES) {
  const chosen: ContextTurn[] = [];
  const completed = (session.turns || [])
    .filter((turn) => turn.status === "completed")
    .map((turn) => ({ user: turnUserText(turn), assistant: turnAssistantText(turn) }))
    .filter((turn) => turn.user && turn.assistant)
    .slice(-2)
    .reverse();
  let remaining = maxBytes;
  for (const turn of completed) {
    if (remaining <= 0) break;
    const block = `User: ${turn.user}\nAssistant: ${turn.assistant}`;
    if (Buffer.byteLength(block, "utf8") <= remaining) {
      chosen.unshift(turn);
      remaining -= Buffer.byteLength(block, "utf8") + 2;
      continue;
    }
    // Truncate the oldest included turn from the end so its latest request and
    // response remain the most specific part of the bounded context.
    const clipped = truncateAiSessionNextInputUtf8(block, Math.max(0, remaining - 2));
    if (clipped.trim()) {
      const separator = clipped.indexOf("\nAssistant:");
      if (separator > 0) {
        chosen.unshift({ user: clipped.slice("User: ".length, separator), assistant: clipped.slice(separator + "\nAssistant: ".length) });
      }
    }
    break;
  }
  return chosen;
}

export function aiSessionNextInputPrompt(session: AiSessionStatus) {
  const context = aiSessionNextInputContext(session);
  const latestUser = [...context].reverse().find((turn) => turn.user)?.user || "";
  const chinese = /[\u3400-\u9fff\uf900-\ufaff]/u.test(latestUser);
  const instruction = chinese
    ? "请基于最近的用户请求和助手回复，预测用户接下来最可能输入的一句话。使用最近一条用户消息的语言，保持具体、自然、可直接编辑。"
    : "Predict the user's most likely next message from the recent request and assistant reply. Use the language of the latest user message. Keep it specific, natural, and directly editable.";
  const format = chinese
    ? '只返回 JSON：{"suggestion":"单行建议"}。不要换行，不要 Markdown，不要解释，不要超过 160 个 Unicode 字符。'
    : 'Return only JSON: {"suggestion":"one line"}. No newlines, Markdown, or explanation. At most 160 Unicode characters.';
  return [
    instruction,
    format,
    "Do not repeat the previous user message. Do not claim work has been done.",
    "",
    context.map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`).join("\n\n"),
  ].join("\n").trim();
}

export function parseAiSessionNextInputSuggestion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const bounded = truncateAiSessionNextInputUtf8(raw, AI_SESSION_NEXT_INPUT_RESPONSE_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(bounded);
  } catch {
    return undefined;
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof record.suggestion !== "string") return undefined;
  let text = record.suggestion.replace(/\s+/gu, " ").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = Array.from(text).slice(0, AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS).join("").trim();
  return text || undefined;
}

export function latestCompletedTurn(session: AiSessionStatus) {
  const latest = (session.turns || []).at(-1);
  return latest?.status === "completed" ? latest : undefined;
}

function turnMatchesProviderTurn(
  turn: NonNullable<AiSessionStatus["turns"]>[number],
  providerTurnId: string,
) {
  return turn.id === providerTurnId || turn.providerTurnId === providerTurnId;
}

export function isAiSessionNextInputEligible(session: AiSessionStatus | undefined) {
  if (!session || session.status !== "idle" || session.queue.pendingCount > 0 || session.lineage?.kind === "subagent") return false;
  return Boolean(latestCompletedTurn(session));
}

export type AiSessionNextInputGenerator = (input: {
  session: AiSessionStatus;
  turn: NonNullable<AiSessionStatus["turns"]>[number];
  reasoningEffort: AiSessionReasoningEffort | undefined;
  signal: AbortSignal;
}) => Promise<string | undefined>;

type CoordinatorOptions = {
  registry: AiSessionRegistry;
  isEnabled: () => boolean;
  reasoningEffort?: () => AiSessionNextInputSuggestionReasoningEffort;
  generate: AiSessionNextInputGenerator;
  debounceMs?: number;
  requestTimeoutMs?: number;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
};

type SessionState = {
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  generation: number;
  requestKey?: string;
  pendingSuccess?: boolean;
  pendingSuccessTurnId?: string;
};

export class AiSessionNextInputSuggestionCoordinator {
  private readonly states = new Map<string, SessionState>();
  private readonly seen = new Set<string>();
  private readonly debounceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly options: CoordinatorOptions;
  private reasoningEffort: AiSessionNextInputSuggestionReasoningEffort;

  constructor(options: CoordinatorOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? AI_SESSION_NEXT_INPUT_DEBOUNCE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? AI_SESSION_NEXT_INPUT_REQUEST_TIMEOUT_MS;
    this.reasoningEffort = options.reasoningEffort?.() ?? AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT;
  }

  observeBaseline(session: AiSessionStatus) {
    const turn = latestCompletedTurn(session);
    if (turn) this.remember(this.key(session, turn));
  }

  observeSuccessfulTurn(sessionId: string, providerTurnId?: string) {
    if (!this.options.isEnabled()) return;
    const session = this.options.registry.get(sessionId);
    if (!session) return;
    if (!isAiSessionNextInputEligible(session)) {
      // Adapters can report success before the registry publishes the settled
      // idle turn. Remember which turn succeeded so the next registry change
      // can schedule without treating a later turn as this success.
      if (session.status === "running" || session.status === "waiting") {
        const state = this.state(sessionId);
        state.pendingSuccess = true;
        state.pendingSuccessTurnId = providerTurnId;
      }
      return;
    }
    const turn = latestCompletedTurn(session);
    if (providerTurnId && turn && !turnMatchesProviderTurn(turn, providerTurnId)) return;
    this.schedule(session);
  }

  observeUserActivity(sessionId: string) {
    this.invalidate(sessionId);
  }

  /** A provider connection reset invalidates in-flight results without clearing
   * an already-published suggestion that may still belong to the settled turn. */
  cancelPending() {
    for (const sessionId of [...this.states.keys()]) this.invalidate(sessionId);
  }

  reconcileSession(sessionId: string) {
    const state = this.states.get(sessionId);
    if (!state) return;
    const session = this.options.registry.get(sessionId);
    if (!this.options.isEnabled()) {
      this.invalidate(sessionId);
      return;
    }
    if (state.pendingSuccess) {
      const latest = session?.turns?.at(-1);
      if (
        !session
        || (latest && state.pendingSuccessTurnId && !turnMatchesProviderTurn(latest, state.pendingSuccessTurnId))
        || (session.status !== "running" && session.status !== "waiting" && !isAiSessionNextInputEligible(session))
      ) {
        state.pendingSuccess = false;
        state.pendingSuccessTurnId = undefined;
      } else if (isAiSessionNextInputEligible(session)) {
        state.pendingSuccess = false;
        state.pendingSuccessTurnId = undefined;
        this.schedule(session);
        return;
      } else {
        return;
      }
    }
    const turn = session ? latestCompletedTurn(session) : undefined;
    if (!isAiSessionNextInputEligible(session) || !turn || (state.requestKey && this.key(session!, turn) !== state.requestKey)) {
      this.invalidate(sessionId);
    }
  }

  retainSessions(activeSessionIds: ReadonlySet<string>) {
    for (const sessionId of [...this.states.keys()]) {
      if (activeSessionIds.has(sessionId)) continue;
      this.invalidate(sessionId);
      this.states.delete(sessionId);
    }
  }

  setEnabled(enabled: boolean) {
    if (!enabled) {
      this.clearAll();
      return;
    }
    for (const session of this.options.registry.list()) this.observeBaseline(session);
  }

  setReasoningEffort(reasoningEffort: AiSessionNextInputSuggestionReasoningEffort) {
    if (this.reasoningEffort === reasoningEffort) return;
    this.clearAll();
    this.reasoningEffort = reasoningEffort;
    for (const session of this.options.registry.list()) this.observeBaseline(session);
  }

  dispose() {
    for (const sessionId of [...this.states.keys()]) this.invalidate(sessionId);
    this.states.clear();
  }

  private clearAll() {
    for (const sessionId of [...this.states.keys()]) this.invalidate(sessionId);
    for (const session of this.options.registry.list()) {
      if (session.nextInputSuggestion) {
        this.options.registry.applyRealtimeEvent(session.id, { kind: "next-input-suggestion", suggestion: null });
      }
    }
  }

  private key(session: AiSessionStatus, turn: NonNullable<AiSessionStatus["turns"]>[number]) {
    return `${session.providerSessionId || session.id}\0${turn.id}\0${turn.completedAt || turn.updatedAt || ""}`;
  }

  private state(sessionId: string) {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const state: SessionState = { generation: 0 };
    this.states.set(sessionId, state);
    return state;
  }

  private invalidate(sessionId: string) {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.generation += 1;
    state.pendingSuccess = false;
    state.pendingSuccessTurnId = undefined;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.controller?.abort();
    state.controller = undefined;
    state.requestKey = undefined;
  }

  private schedule(session: AiSessionStatus) {
    const turn = latestCompletedTurn(session);
    if (!turn) return;
    const key = this.key(session, turn);
    if (this.seen.has(key)) return;
    const state = this.state(session.id);
    if (state.requestKey === key || state.timer || state.controller) return;
    if (!this.remember(key)) return;
    const generation = ++state.generation;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.run(session.id, turn.id, key, generation);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private remember(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MAX_TRACKED_SUGGESTION_KEYS) {
      for (const stale of this.seen) {
        this.seen.delete(stale);
        if (this.seen.size <= MAX_TRACKED_SUGGESTION_KEYS - 1_000) break;
      }
    }
    return true;
  }

  private async run(sessionId: string, turnId: string, key: string, generation: number) {
    const state = this.state(sessionId);
    const initial = this.options.registry.get(sessionId);
    const initialTurn = initial ? latestCompletedTurn(initial) : undefined;
    if (!this.options.isEnabled() || generation !== state.generation || !isAiSessionNextInputEligible(initial) || initialTurn?.id !== turnId) return;
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    state.controller = controller;
    state.requestKey = key;
    try {
      const reasoningEffort = resolveAiSessionNextInputSuggestionReasoningEffort(
        this.reasoningEffort,
        initial!.reasoningEffort,
      );
      const request = this.options.generate({
        session: initial!,
        turn: initialTurn!,
        reasoningEffort,
        signal: controller.signal,
      });
      // Adapters that cannot cancel an in-flight structured turn must not keep
      // the coordinator slot occupied past the request deadline. The late
      // result is discarded by the generation checks below.
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("AI session next input suggestion request timed out"));
        }, this.requestTimeoutMs);
        timeout.unref?.();
      });
      const raw = await Promise.race([request, deadline]);
      const text = parseAiSessionNextInputSuggestion(raw);
      if (!text || controller.signal.aborted || !this.options.isEnabled() || generation !== state.generation) return;
      const current = this.options.registry.get(sessionId);
      const currentTurn = current ? latestCompletedTurn(current) : undefined;
      if (!isAiSessionNextInputEligible(current) || currentTurn?.id !== turnId || this.key(current!, currentTurn!) !== key) return;
      const suggestion: AiSessionNextInputSuggestion = {
        text,
        turnId,
        generatedAt: new Date().toISOString(),
      };
      this.options.registry.applyRealtimeEvent(sessionId, { kind: "next-input-suggestion", suggestion });
    } catch (error) {
      if (!controller.signal.aborted && !timedOut) {
        this.options.onDiagnostic?.({
          code: "AI_SESSION_NEXT_INPUT_GENERATION_FAILED",
          sessionId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (state.controller === controller) state.controller = undefined;
      if (state.requestKey === key) state.requestKey = undefined;
    }
  }
}
