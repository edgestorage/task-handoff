import { useEventListener } from "@vueuse/core";
import { ref } from "vue";
import type { AiSessionSummary, AiSessionTurn } from "../../api/types";

export type AiSessionPreviewKind = "prompt" | "message";

export interface ExpandedAiSessionPreview {
  sessionId: string;
  kind: AiSessionPreviewKind;
}

export function useAiSessionPrompts() {
  const promptIndexes = ref<Record<string, { index: number; count: number }>>({});

  function promptCount(session: AiSessionSummary) {
    return aiSessionUserPrompts(session).length;
  }

  function promptIndexFor(session: AiSessionSummary) {
    const count = promptCount(session);
    if (!count) {
      return 0;
    }
    const saved = promptIndexes.value[session.id];
    if (!saved) {
      return count - 1;
    }
    const wasFollowingLatest = saved.index >= saved.count - 1;
    if (wasFollowingLatest && count !== saved.count) {
      return count - 1;
    }
    return Math.min(Math.max(saved.index, 0), count - 1);
  }

  function setPromptIndex(session: AiSessionSummary, index: number) {
    const count = promptCount(session);
    if (!count) {
      return;
    }
    promptIndexes.value = {
      ...promptIndexes.value,
      [session.id]: { index: (index + count) % count, count },
    };
  }

  function previousPrompt(session: AiSessionSummary) {
    setPromptIndex(session, promptIndexFor(session) - 1);
  }

  function nextPrompt(session: AiSessionSummary) {
    setPromptIndex(session, promptIndexFor(session) + 1);
  }

  return {
    nextPrompt,
    previousPrompt,
    promptCount,
    promptIndexFor,
  };
}

export function useAiSessionExpandedPreview() {
  const expandedPreview = ref<ExpandedAiSessionPreview>();

  function toggleExpandedPreview(sessionId: string, kind: AiSessionPreviewKind) {
    const current = expandedPreview.value;
    expandedPreview.value = current?.sessionId === sessionId && current.kind === kind ? undefined : { sessionId, kind };
  }

  function expandPrompt(sessionId: string) {
    toggleExpandedPreview(sessionId, "prompt");
  }

  function expandMessage(sessionId: string) {
    toggleExpandedPreview(sessionId, "message");
  }

  function collapseExpandedPreview() {
    expandedPreview.value = undefined;
  }

  function closeExpandedPreview(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target || target.closest(".ai-session-expanded-preview") || target.closest("[data-ai-preview-trigger]")) {
      return;
    }
    expandedPreview.value = undefined;
  }

  useEventListener(document, "click", closeExpandedPreview, { capture: true });

  return {
    collapseExpandedPreview,
    expandMessage,
    expandedPreview,
    expandPrompt,
  };
}

export function relativeTime(value?: string) {
  if (!value) {
    return "";
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const ageMinutes = Math.round(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  return `${Math.round(ageMinutes / 60)}h ago`;
}

export function sortedAiSessions(items: AiSessionSummary[]) {
  return [...items].sort((a, b) => {
    const priorityDelta = aiSessionPriority(b) - aiSessionPriority(a);
    return priorityDelta || aiSessionStableSortKey(a).localeCompare(aiSessionStableSortKey(b));
  });
}

function aiSessionPriority(session: AiSessionSummary) {
  if (session.status === "waiting") {
    return 4;
  }
  if (session.status === "failed") {
    return 3;
  }
  if (session.status === "running") {
    return 2;
  }
  if (session.status === "idle") {
    return 1;
  }
  return 0;
}

function aiSessionStableSortKey(session: AiSessionSummary) {
  return [
    session.cwd || "",
    session.agent || "",
    session.providerSessionId || session.id,
  ].join("\u0000");
}

export function aiSessionStatusLabel(session?: AiSessionSummary) {
  if (!session) {
    return "idle";
  }
  if (session.status === "waiting") {
    return session.phase === "approval" ? "waiting for approval" : "waiting";
  }
  if (session.status === "running") {
    if (session.currentTool?.name) {
      return `running · ${session.currentTool.name}`;
    }
    if (session.phase === "tool") {
      return "running · tool";
    }
    if (session.phase === "editing") {
      return "running · editing";
    }
    if (session.phase === "responding") {
      return "running · responding";
    }
    return "running";
  }
  if (session.status === "failed") {
    return "failed";
  }
  return "idle";
}

export function displayAiSessionMessage(session?: AiSessionSummary, promptIndex?: number) {
  if (!session) {
    return "No recent AI activity";
  }
  const turns = aiSessionDisplayTurns(session);
  if (turns.length && promptIndex !== undefined) {
    const index = Math.min(Math.max(promptIndex, 0), turns.length - 1);
    const turn = turns[index];
    if (turn?.lastMessage?.trim()) {
      return turn.lastMessage;
    }
    if (turn?.summary?.trim()) {
      return turn.summary;
    }
    return aiSessionProgressText(session);
  }
  const latestTurn = turns.at(-1);
  if (latestTurn && !latestTurn.lastMessage?.trim() && !latestTurn.summary?.trim()) {
    return aiSessionProgressText(session);
  }
  if (session.lastMessage?.trim()) {
    return session.lastMessage;
  }
  if (session.summary?.trim()) {
    return session.summary;
  }
  return aiSessionProgressText(session);
}

function aiSessionUserPrompts(session?: AiSessionSummary) {
  if (!session) {
    return [];
  }
  return aiSessionDisplayTurns(session)
    .map((turn) => turn.userPrompt?.trim() || "")
    .filter(Boolean);
}

function aiSessionTurns(session?: AiSessionSummary) {
  return (session?.turns || []).filter((turn) => turn.userPrompt?.trim() || turn.lastMessage?.trim() || turn.summary?.trim());
}

function aiSessionDisplayTurns(session?: AiSessionSummary) {
  if (!session) {
    return [];
  }
  const turns: AiSessionTurn[] = aiSessionTurns(session);
  const prompt = session.userPrompt?.trim();
  if (!prompt) {
    return turns;
  }
  const activeTurn = session.activeTurnId ? turns.find((turn) => turn.id === session.activeTurnId) : undefined;
  if (activeTurn) {
    if ((session.status === "running" || session.status === "waiting") && activeTurn.userPrompt?.trim() === prompt) {
      return [
        ...turns.filter((turn) => turn.id !== activeTurn.id),
        activeTurn,
      ];
    }
    return turns;
  }
  const latest = turns.at(-1);
  if (latest?.userPrompt?.trim() === prompt && !latest.lastMessage?.trim() && !latest.summary?.trim()) {
    return turns;
  }
  if (session.status === "running" || session.status === "waiting") {
    const pendingTurn: AiSessionTurn = {
      id: session.activeTurnId || `${session.id}:active`,
      userPrompt: prompt,
      status: session.status === "waiting" ? "waiting" : "running",
      phase: session.phase,
      revision: 0,
      updatedAt: session.updatedAt,
    };
    return [
      ...turns,
      pendingTurn,
    ];
  }
  return turns;
}

function aiSessionProgressText(session: AiSessionSummary) {
  if (session.currentTool?.name) {
    return session.currentTool.inputPreview ? `${session.currentTool.name}: ${session.currentTool.inputPreview}` : session.currentTool.name;
  }
  if (session.status === "running") {
    return "Running...";
  }
  if (session.status === "waiting") {
    return session.phase === "approval" ? "Waiting for approval." : "Waiting...";
  }
  return "-";
}

export function displayAiSessionTitle(session?: AiSessionSummary, promptIndex?: number) {
  if (!session) {
    return "No AI session selected";
  }
  const prompts = aiSessionUserPrompts(session);
  if (prompts.length) {
    const index = promptIndex === undefined ? prompts.length - 1 : Math.min(Math.max(promptIndex, 0), prompts.length - 1);
    return prompts[index];
  }
  return "-";
}

export function aiSessionContext(session: AiSessionSummary) {
  const cwd = aiSessionBasename(session.cwd);
  const id = shortAiSessionId(session.providerSessionId || session.id);
  if (cwd && id) {
    return `${cwd} · ${id}`;
  }
  return cwd || id || session.agent;
}

function aiSessionBasename(value?: string) {
  if (!value) {
    return "";
  }
  return value.split(/[\\/]/).filter(Boolean).at(-1) || value;
}

function shortAiSessionId(value?: string) {
  if (!value) {
    return "";
  }
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function aiSessionCounts(items: AiSessionSummary[]) {
  return {
    active: items.filter((entry) => entry.status === "running").length,
    idle: items.filter((entry) => entry.status === "idle").length,
    waiting: items.filter((entry) => entry.status === "waiting").length,
  };
}

export function canInterrupt(session: AiSessionSummary) {
  const canControlClaude = session.agent === "claude" && typeof session.providerMeta?.short === "string";
  return Boolean((session.activeTurnId || canControlClaude) && (session.status === "running" || session.status === "waiting"));
}

export function canResolveApproval(session: AiSessionSummary) {
  return session.status === "waiting" && session.phase === "approval";
}
