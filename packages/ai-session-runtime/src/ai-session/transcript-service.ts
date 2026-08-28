import fs from "node:fs";
import { findClaudeTranscriptPath, findCodexTranscriptPath, summarizeTranscriptLine } from "@task-handoff/core/core/transcript";
import type {
  AiSessionLifecycle,
  AiSessionPhase,
  AiSessionRealtimeInput,
  AiSessionSnapshotInput,
  AiSessionSource,
  AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import {
  compact,
  messageText,
  transcriptTurnId,
  turnMeta,
  updateTurns,
  type TurnMeta,
} from "../ai-session-turns";

const DEFAULT_TRANSCRIPT_BACKFILL_MAX_BYTES = 512 * 1024;

export type AiSessionTranscriptAgent = "codex" | "claude";

export type AiSessionTranscriptToolCallState = {
  tool: string;
  command: string;
  ignored: boolean;
  action?: string;
};

export type AiSessionTranscriptState = {
  calls: Map<string, AiSessionTranscriptToolCallState>;
  promptCounts?: Map<string, number>;
  activeTurnId?: string;
};

export type AiSessionTranscriptBackfill = {
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  lastMessage?: string;
  summary?: string;
};

export type AiSessionTranscriptStartInput = {
  agent: string;
  providerSessionId?: string;
  cwd?: string;
  userPrompt?: string;
  turns?: AiSessionStatus["turns"];
  status?: AiSessionLifecycle;
  phase?: AiSessionPhase;
  summary?: string;
};

/**
 * Minimal session facade used by transcript ingestion. Keeping this structural
 * avoids making transcript parsing depend on the concrete registry/store.
 */
export type AiSessionTranscriptRegistry = {
  get: (id: string) => AiSessionStatus | undefined;
  findTranscriptSession: (identity: {
    transcriptPath: string;
    providerSessionId?: string;
  }) => AiSessionStatus | undefined;
  start: (
    input: AiSessionTranscriptStartInput,
    options?: { meta?: TurnMeta; timestamp?: string; suppressPromptTurn?: boolean },
  ) => AiSessionStatus;
  applyRealtimeEvent: (
    id: string,
    event: Omit<AiSessionRealtimeInput, "type" | "sessionId" | "source"> & { source?: AiSessionSource },
  ) => AiSessionStatus | undefined;
  applyAdapterSnapshot: (
    snapshot: Omit<AiSessionSnapshotInput, "type" | "source"> & { source?: AiSessionSource },
  ) => AiSessionStatus | undefined;
};

export type AiSessionTranscriptServiceOptions = {
  idleAfterMs: number;
  staleAfterMs: number;
  maxBackfillBytes?: number;
  now?: () => number;
};

function maxIso(lhs: string, rhs: string) {
  return Date.parse(lhs) >= Date.parse(rhs) ? lhs : rhs;
}

export function resolveAiSessionTranscript(
  agent: string,
  providerSessionId?: string,
  cwd?: string,
) {
  if (!providerSessionId) {
    return undefined;
  }
  return agent === "claude"
    ? findClaudeTranscriptPath(providerSessionId, cwd)
    : findCodexTranscriptPath(providerSessionId);
}

export class AiSessionTranscriptService {
  private readonly idleAfterMs: number;
  private readonly staleAfterMs: number;
  private readonly maxBackfillBytes: number;
  private readonly now: () => number;

  constructor(options: AiSessionTranscriptServiceOptions) {
    this.idleAfterMs = options.idleAfterMs;
    this.staleAfterMs = options.staleAfterMs;
    this.maxBackfillBytes = options.maxBackfillBytes ?? DEFAULT_TRANSCRIPT_BACKFILL_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  readTail(transcriptPath: string, stat = fs.statSync(transcriptPath)) {
    const start = Math.max(0, stat.size - this.maxBackfillBytes);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  backfill(transcriptPath: string, stat = fs.statSync(transcriptPath)): AiSessionTranscriptBackfill {
    const state: AiSessionTranscriptState = { calls: new Map() };
    const backfill: AiSessionTranscriptBackfill = {};
    const promptCounts = new Map<string, number>();

    for (const line of this.readTail(transcriptPath, stat).split(/\r?\n/)) {
      const summary = summarizeTranscriptLine(line, state);
      if (!summary?.text) {
        continue;
      }
      const timestamp = summary.timestamp || stat.mtime.toISOString();
      if (summary.kind === "user") {
        const userPrompt = messageText(summary.text);
        backfill.userPrompt = userPrompt;
        const seed = summary.key || summary.timestamp;
        if (seed) {
          state.activeTurnId = transcriptTurnId(userPrompt, seed);
        } else {
          const occurrence = (promptCounts.get(userPrompt) || 0) + 1;
          promptCounts.set(userPrompt, occurrence);
          state.activeTurnId = transcriptTurnId(userPrompt, undefined, occurrence);
        }
        backfill.turns = updateTurns(backfill.turns, { activeTurnId: state.activeTurnId, userPrompt }, timestamp);
        continue;
      }
      if (summary.kind !== "assistant") continue;
      backfill.summary = compact(summary.text, 1000);
      backfill.lastMessage = messageText(summary.text);
      backfill.turns = updateTurns(backfill.turns, {
        activeTurnId: state.activeTurnId,
        summary: backfill.summary,
        lastMessage: backfill.lastMessage,
      }, timestamp);
    }
    return backfill;
  }

  ingestLine(
    registry: AiSessionTranscriptRegistry,
    id: string,
    line: string,
    state: AiSessionTranscriptState,
  ) {
    const summary = summarizeTranscriptLine(line, state);
    if (!summary?.text) {
      return registry.get(id);
    }
    const timestamp = summary.timestamp || new Date(this.now()).toISOString();
    if (summary.kind === "user") {
      const userPrompt = messageText(summary.text);
      const seed = summary.key || summary.timestamp;
      if (seed) {
        state.activeTurnId = transcriptTurnId(userPrompt, seed);
      } else {
        state.promptCounts ||= new Map<string, number>();
        const occurrence = (state.promptCounts.get(userPrompt) || 0) + 1;
        state.promptCounts.set(userPrompt, occurrence);
        state.activeTurnId = transcriptTurnId(userPrompt, undefined, occurrence);
      }
      return registry.applyRealtimeEvent(id, {
        kind: "user-message",
        activeTurnId: state.activeTurnId,
        providerTurnId: state.activeTurnId,
        userPrompt,
        observedAt: timestamp,
        source: "transcript-tail",
      });
    }
    if (summary.kind === "assistant") {
      return registry.applyRealtimeEvent(id, {
        kind: "assistant-message",
        activeTurnId: state.activeTurnId,
        providerTurnId: state.activeTurnId,
        text: summary.text,
        observedAt: timestamp,
        source: "transcript-tail",
      });
    }
    return registry.get(id);
  }

  createFromTranscript(
    registry: AiSessionTranscriptRegistry,
    agent: AiSessionTranscriptAgent,
    transcriptPath: string,
    options: { providerSessionId?: string; cwd?: string } = {},
  ) {
    const stat = fs.statSync(transcriptPath);
    const timestamp = stat.mtime.toISOString();
    const backfill = this.backfill(transcriptPath, stat);
    const existing = registry.findTranscriptSession({
      transcriptPath,
      providerSessionId: options.providerSessionId,
    });
    if (existing) {
      const transcriptOnly = !existing.appSessionId;
      const hasKnownSize = Number.isInteger(existing.transcriptSize);
      const sizeIncreased = hasKnownSize && stat.size > Number(existing.transcriptSize);
      const observedAt = transcriptOnly && sizeIncreased
        ? new Date(this.now()).toISOString()
        : transcriptOnly && !sizeIncreased
          ? existing.updatedAt
          : maxIso(existing.updatedAt, timestamp);
      return registry.applyAdapterSnapshot({
        source: "transcript-scan",
        agent,
        transcriptPath,
        transcriptSize: stat.size,
        providerSessionId: options.providerSessionId || existing.providerSessionId,
        cwd: options.cwd || existing.cwd,
        userPrompt: existing.userPrompt || backfill.userPrompt,
        turns: backfill.turns?.length ? backfill.turns : existing.turns,
        summary: backfill.summary || existing.summary,
        lastMessage: backfill.lastMessage || existing.lastMessage,
        status: transcriptOnly && sizeIncreased ? "running" : existing.status,
        phase: transcriptOnly && sizeIncreased && existing.phase === "unknown" ? "responding" : existing.phase,
        observedAt,
        replaceActivity: Boolean(backfill.turns?.length),
      }) || existing;
    }

    const session = registry.start({
      agent,
      providerSessionId: options.providerSessionId,
      cwd: options.cwd,
      userPrompt: backfill.userPrompt,
      turns: backfill.turns,
      status: this.lifecycleForMtime(stat.mtimeMs),
      phase: "unknown",
      summary: backfill.summary || `${agent} transcript detected`,
    }, {
      meta: turnMeta({ source: "transcript-scan", observedAt: timestamp }),
      timestamp,
      suppressPromptTurn: !backfill.turns?.length,
    });
    return registry.applyAdapterSnapshot({
      source: "transcript-scan",
      agent: session.agent,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      userPrompt: session.userPrompt,
      turns: session.turns,
      summary: session.summary,
      lastMessage: backfill.lastMessage,
      transcriptPath,
      transcriptSize: stat.size,
      status: session.status,
      phase: session.phase,
      observedAt: timestamp,
    }) || session;
  }

  private lifecycleForMtime(mtimeMs: number): AiSessionLifecycle {
    const age = this.now() - mtimeMs;
    if (age > this.staleAfterMs) {
      return "idle";
    }
    if (age > this.idleAfterMs) {
      return "idle";
    }
    return "running";
  }
}
