import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../api/types";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import { appSessionBindingKeys, appSessionStatus, isVisibleAppSession } from "./appSessionVisibility.ts";
import { aiSessionStatusKeys, translateStatus, type Translate } from "../../i18n/status.ts";
import { formatRelativeTime, formatTime } from "../../i18n/presentation.ts";
import type { SupportedLocale } from "../../i18n/locale.ts";

export type SessionTab = {
  key: string;
  label: string;
  title?: string;
  status: string;
  kind: "terminal" | "browser" | "logs" | "app" | "ai" | "status" | "repository";
  source?: Record<string, unknown>;
  aiSessions?: AiSessionSummary[];
};

export type RepositoryWorkspaceTabTarget = {
  filePath?: string;
  fileRequestId?: number;
  initialView: "files" | "changes";
  page?: "workspace" | "changes-review";
  sessionId: string;
  sessionKind: RepositorySessionKind;
};

export type SessionWorkspaceGroup = {
  key: string;
  label: string;
  sessions: SessionTab[];
};

export type LaunchableApp = {
  id: string;
  label: string;
  supportsCwdSelection?: boolean;
};

const CWD_SELECTABLE_APP_IDS = new Set(["codex", "claude", "terminal-tty", "gui-terminal", "terminal"]);

function instanceWebBase(instance: InstanceBoardItem) {
  return `/instances/${encodeURIComponent(instance.id)}`;
}

function joinInstancePath(instance: InstanceBoardItem, path: string) {
  const base = instanceWebBase(instance).replace(/\/$/, "");
  if (!path) {
    return `${base}/`;
  }
  if (/^https?:\/\//i.test(path)) {
    try {
      return `${base}${new URL(path).pathname}${new URL(path).search}${new URL(path).hash}`;
    } catch {
      return path;
    }
  }
  return `${base}/${path.replace(/^\//, "")}`;
}

function instancePathParam(instance: InstanceBoardItem, path: string) {
  return joinInstancePath(instance, path).replace(/^\//, "");
}

function proxiedWebSocketUrl(instance: InstanceBoardItem, path: string) {
  const proxiedPath = joinInstancePath(instance, path);
  if (typeof window === "undefined") {
    return proxiedPath;
  }
  const url = new URL(proxiedPath, window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function buildAppSessionTabs(instance: InstanceBoardItem | undefined, t: Translate): SessionTab[] {
  if (!instance) {
    return [];
  }
  return instance.apps.sessions.map((session, index) => appSessionTab(session, index, t)).filter((session): session is SessionTab => Boolean(session));
}

export function buildSessionTabs(instance: InstanceWithAiSessions | undefined, t: Translate): SessionTab[] {
  if (!instance) {
    return [];
  }
  if (instance.status !== "running") {
    return [{
      key: "overview",
      label: t("sessions.tabs.status"),
      status: instance.status,
      kind: "status",
    }];
  }
  const appSessions = buildAppSessionTabs(instance, t);
  const visibleAiSessions = aiSessionSnapshotSessions(instance.aiSessions);
  const aiSessionTab: SessionTab = {
    key: "ai-sessions",
    label: t("sessions.title"),
    status: visibleAiSessions.some((session) => session.status === "waiting")
      ? "waiting"
      : visibleAiSessions.some((session) => session.status === "running")
        ? "running"
        : "idle",
    kind: "ai",
    aiSessions: visibleAiSessions,
  };
  return [aiSessionTab, ...appSessions];
}

function appSessionTab(session: Record<string, unknown>, index: number, t?: Translate): SessionTab | undefined {
  if (!isVisibleAppSession(session)) {
    return undefined;
  }
  const appId = typeof session.appId === "string" ? session.appId : t ? t("sessions.tabs.appFallback", { number: index + 1 }) : `app-${index + 1}`;
  const status = typeof session.status === "string" ? session.status : "running";
  const key = typeof session.id === "string" ? session.id : `${appId}-${index}`;
  return {
    key,
    label: appId,
    title: typeof session.title === "string" && session.title.trim() ? session.title.trim() : undefined,
    status,
    kind: sessionKind(appId, session),
    source: session,
  };
}

export function sessionKind(appId: string, session?: Record<string, unknown>): SessionTab["kind"] {
  if (session?.kind === "tty") {
    return "terminal";
  }
  if (session?.kind === "gui" || session?.kind === "web") {
    return "browser";
  }
  const value = appId.toLowerCase();
  if (value.includes("terminal") || value.includes("tty")) {
    return "terminal";
  }
  if (value.includes("browser") || value.includes("vnc")) {
    return "browser";
  }
  if (value.includes("log")) {
    return "logs";
  }
  return "app";
}

export function sessionFrameUrl(instance: InstanceBoardItem, session: SessionTab, options: { compact?: boolean; interactive?: boolean } = {}) {
  if (!instanceWebBase(instance) || !session.source || session.kind === "terminal" || session.kind === "ai") {
    return "";
  }
  const id = typeof session.source.id === "string" ? session.source.id : session.key;
  const web = session.source.web && typeof session.source.web === "object" ? (session.source.web as Record<string, unknown>) : undefined;
  const webPath = typeof web?.webPath === "string" ? web.webPath : undefined;
  if (session.source.kind === "web") {
    return absoluteInstanceUrl(instance, webPath || `/api/apps/sessions/${encodeURIComponent(id)}/web/`);
  }
  if (session.source.kind === "gui" || session.kind === "browser") {
    const path = `/api/apps/sessions/${encodeURIComponent(id)}/web/`;
    const compact = Boolean(options.compact);
    const query = new URLSearchParams({
      path: instancePathParam(instance, `/api/apps/sessions/${id}/web/websockify`),
      autoconnect: "1",
      resize: "scale",
      enable_hidpi: compact ? "0" : "1",
      forced_resolution_x: compact ? "640" : "1440",
      forced_resolution_y: compact ? "360" : "900",
    });
    if (compact) {
      query.set("quality", "1");
      query.set("compression", "9");
      if (!options.interactive) {
        query.set("view_only", "1");
      }
      query.set("show_dot", "1");
    } else {
      query.set("show_control_bar", "1");
    }
    return absoluteInstanceUrl(instance, `${path}?${query.toString()}`);
  }
  return "";
}

export function sessionTerminalSocketUrl(instance: InstanceBoardItem, session: SessionTab) {
  if (!instanceWebBase(instance) || session.kind !== "terminal" || !session.source) {
    return "";
  }
  const tty = session.source.tty && typeof session.source.tty === "object" ? (session.source.tty as Record<string, unknown>) : undefined;
  const id = typeof session.source.id === "string" ? session.source.id : session.key;
  const path = typeof tty?.webPath === "string" ? tty.webPath : `/api/apps/sessions/${encodeURIComponent(id)}/tty`;
  return proxiedWebSocketUrl(instance, path);
}

export function appDisplayName(id: string, t: Translate) {
  const names: Record<string, string> = {
    "terminal-tty": t("sessions.tabs.terminal"),
    "gui-terminal": `GUI ${t("sessions.tabs.terminal")}`,
    chromium: "Chromium",
    browser: t("sessions.tabs.browser"),
    "vscode-web": "VS Code",
  };
  return names[id] || id.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function sessionDisplayName(session: SessionTab | undefined, t: Translate) {
  return session ? session.title || appDisplayName(session.label, t) : t("sessions.tabs.session");
}

export function aiSessionAppDisplayName(appTab: SessionTab | undefined, fallback: string, t: Translate) {
  return appTab?.source ? sessionDisplayName(appTab, t) : fallback;
}

export function launchableAppsForInstance(instance: InstanceBoardItem, t: Translate): LaunchableApp[] {
  if (instance.connectionStatus !== "online" || !instance.appInventory) {
    return [];
  }
  return uniqueLaunchableApps(
    instance.appInventory.items
      .filter((app) => app.availability === "available")
      .map((app): LaunchableApp | undefined => {
        return {
          id: app.id,
          label: app.name || appDisplayName(app.id, t),
          supportsCwdSelection: app.capabilities.supportsCwdSelection,
        };
      })
      .filter((app): app is LaunchableApp => Boolean(app)),
  );
}

export function supportsAppCwdSelection(appId: string) {
  return CWD_SELECTABLE_APP_IDS.has(appId);
}

export function uniqueLaunchableApps(apps: LaunchableApp[]) {
  const byId = new Map<string, LaunchableApp>();
  for (const app of apps) {
    if (!byId.has(app.id)) {
      byId.set(app.id, app);
    }
  }
  return [...byId.values()];
}

export function sessionMeta(session: SessionTab, t: Translate) {
  if (session.kind === "ai") {
    return aiSessionListHeadline(session.aiSessions || [], t);
  }
  const kind = sessionKindDisplayName(typeof session.source?.kind === "string" ? session.source.kind : session.kind, t);
  const id = typeof session.source?.id === "string" ? session.source.id : session.key;
  return [kind, id].filter(Boolean).join(" · ");
}

export function shouldGroupAppSessionTabs(instance: InstanceBoardItem, sessions: SessionTab[]) {
  const appSessions = sessions.filter((session) => session.kind !== "ai" && session.kind !== "status");
  if (appSessions.length < 2) {
    return false;
  }
  return new Set(appSessions.map((session) => sessionWorkspacePath(session, instance))).size > 1;
}

export function groupedAppSessionTabs(instance: InstanceBoardItem, sessions: SessionTab[], activeSessionKey: string, t: Translate): SessionWorkspaceGroup[] {
  const appSessions = sessions.filter((session) => session.kind !== "ai" && session.kind !== "status");
  const groups = new Map<string, SessionTab[]>();
  for (const session of appSessions) {
    const workspace = sessionWorkspaceKey(session, instance);
    groups.set(workspace, [...(groups.get(workspace) || []), session]);
  }
  const activeWorkspace = appSessions.find((session) => session.key === activeSessionKey)
    ? sessionWorkspaceKey(appSessions.find((session) => session.key === activeSessionKey) as SessionTab, instance)
    : "";
  return [...groups.entries()]
    .map(([key, groupSessions]) => ({
      key,
      label: sessionWorkspaceLabel(key, t),
      sessions: [...groupSessions].sort((a, b) => Number(b.key === activeSessionKey) - Number(a.key === activeSessionKey)),
    }))
    .sort((a, b) => {
      const activeDelta = Number(b.key === activeWorkspace) - Number(a.key === activeWorkspace);
      return activeDelta || a.label.localeCompare(b.label);
    });
}

export function sessionWorkspacePath(session: SessionTab, instance: InstanceBoardItem) {
  return sessionWorkspaceKey(session, instance);
}

function sessionWorkspaceKey(session: SessionTab, instance: InstanceBoardItem) {
  if (session.kind === "ai") {
    return "__ai_sessions__";
  }
  if (session.kind === "status") {
    return "__status__";
  }
  const source = session.source || {};
  const tty = objectValue(source.tty);
  const ai = objectValue(source.ai);
  const codex = objectValue(ai?.codex);
  const claude = objectValue(ai?.claude);
  const launch = objectValue(source.launch);
  return stringValue(tty?.cwd)
    || stringValue(codex?.cwd)
    || stringValue(claude?.cwd)
    || stringValue(launch?.cwd)
    || stringValue(instance.runtime?.workspacePath)
    || stringValue(instance.workspace?.path)
    || "__unknown_workspace__";
}

function sessionWorkspaceLabel(key: string, t: Translate) {
  if (key === "__ai_sessions__") return t("sessions.title");
  if (key === "__status__") return t("sessions.tabs.status");
  if (key === "__unknown_workspace__") return t("sessions.tabs.unknownWorkspace");
  return key;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function sessionKindDisplayName(kind: string, t: Translate) {
  const labels: Record<string, string> = {
    tty: t("sessions.tabs.terminal"),
    terminal: t("sessions.tabs.terminal"),
    gui: "GUI",
    web: "Web",
    browser: t("sessions.tabs.browser"),
    app: t("sessions.tabs.app"),
    logs: t("sessions.tabs.logs"),
    ai: "AI",
  };
  return labels[kind] || appDisplayName(kind, t);
}

export function primaryAiSession(instance: InstanceWithAiSessions): AiSessionSummary | undefined {
  return sortedAiSessions(aiSessionSnapshotSessions(instance.aiSessions))[0];
}

export function sortedAiSessions(sessions?: AiSessionSummary[]) {
  return [...(sessions || [])].sort((a, b) => {
    const priorityDelta = aiSessionPriority(b) - aiSessionPriority(a);
    return priorityDelta || aiSessionStableSortKey(a).localeCompare(aiSessionStableSortKey(b));
  });
}

export function sortedAiSessionsByLastUserMessage(sessions?: AiSessionSummary[], sortByStatus = true) {
  return [...(sessions || [])].sort((a, b) => {
    return compareAiSessionsByLastUserMessage(a, b, sortByStatus) || aiSessionStableSortKey(a).localeCompare(aiSessionStableSortKey(b));
  });
}

export function compareAiSessionsByLastUserMessage(left: AiSessionSummary, right: AiSessionSummary, sortByStatus = true) {
  if (sortByStatus) {
    const priorityDelta = aiSessionPriority(right) - aiSessionPriority(left);
    if (priorityDelta) {
      return priorityDelta;
    }
  }
  return aiSessionLastUserMessageTime(right) - aiSessionLastUserMessageTime(left);
}

export function aiSessionLastUserMessageTime(session: AiSessionSummary) {
  const lastUserTurn = [...(session.turns || [])].reverse().find((turn) => turn.userPrompt?.trim());
  if (!lastUserTurn?.startedAt) {
    return 0;
  }
  const timestamp = Date.parse(lastUserTurn.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function aiSessionPriority(session: AiSessionSummary) {
  if (session.status === "waiting") return 4;
  if (session.status === "failed") return 3;
  if (session.status === "running") return 2;
  if (session.status === "idle") return 1;
  return 0;
}

export function aiSessionStableSortKey(session: AiSessionSummary) {
  return [
    session.cwd || "",
    session.agent || "",
    session.providerSessionId || session.id,
  ].join("\u0000");
}

export function primaryAiSessionMessage(instance: InstanceWithAiSessions, t: Translate) {
  return displayAiSessionMessage(primaryAiSession(instance), undefined, t);
}

export function aiSessionHeadline(instance: InstanceBoardItem | InstanceWithAiSessions, t: Translate) {
  const snapshot = instance.aiSessions;
  if (snapshot) {
    const counts = aiSessionCounts(snapshot);
    if (!counts.active && !counts.idle && !counts.waiting) return t("sessions.board.activity");
    return `AI ${aiSessionSnapshotHeadline(snapshot, t)}`;
  }
  return t("sessions.board.activity");
}

export function aiSessionSnapshotHeadline(snapshot: InstanceBoardItem["aiSessions"] | InstanceWithAiSessions["aiSessions"], t: Translate) {
  const counts = aiSessionCounts(snapshot);
  const parts = [];
  if (counts.active) {
    parts.push(t("sessions.board.countActive", { count: counts.active }));
  }
  if (counts.idle) {
    parts.push(t("sessions.board.countIdle", { count: counts.idle }));
  }
  if (counts.waiting) {
    parts.push(t("sessions.board.countWaiting", { count: counts.waiting }));
  }
  return parts.length ? parts.join(" · ") : [t("sessions.board.countActive", { count: 0 }), t("sessions.board.countIdle", { count: 0 }), t("sessions.board.countWaiting", { count: 0 })].join(" · ");
}

export function aiSessionListHeadline(sessions: AiSessionSummary[], t: Translate) {
  const counts = aiSessionCounts({ sessions });
  return [
    t("sessions.board.countActive", { count: counts.active }),
    counts.idle ? t("sessions.board.countIdle", { count: counts.idle }) : "",
    t("sessions.board.countWaiting", { count: counts.waiting }),
  ].filter(Boolean).join(" · ");
}

export function aiSessionCounts(snapshot?: { runningCount?: number; waitingCount?: number; idleCount?: number; sessions?: AiSessionSummary[] }) {
  const sessions = aiSessionSnapshotSessions(snapshot);
  if (!sessions.length && snapshot) {
    return {
      active: snapshot.runningCount || 0,
      idle: snapshot.idleCount || 0,
      waiting: snapshot.waitingCount || 0,
    };
  }
  return {
    active: sessions.filter((entry) => entry.status === "running").length,
    idle: sessions.filter((entry) => entry.status === "idle").length,
    waiting: sessions.filter((entry) => entry.status === "waiting").length,
  };
}

function aiSessionSnapshotSessions(snapshot?: { sessions?: AiSessionSummary[] } | object) {
  const record = snapshot && typeof snapshot === "object" ? snapshot as { sessions?: unknown } : undefined;
  return Array.isArray(record?.sessions) ? record.sessions as AiSessionSummary[] : [];
}

export function aiSessionStatusLabel(session: AiSessionSummary | undefined, t: Translate) {
  if (!session) {
    return t("sessions.status.idle");
  }
  if (session.status === "waiting") {
    return session.phase === "approval" ? t("sessions.status.waitingApproval") : t("sessions.status.waiting");
  }
  if (session.status === "running") {
    if (session.currentTool?.name) {
      return `${t("sessions.status.running")} · ${session.currentTool.name}`;
    }
    if (session.phase === "tool") {
      return t("sessions.status.runningWith", { detail: t("sessions.status.tool") });
    }
    if (session.phase === "editing") {
      return t("sessions.status.runningWith", { detail: t("sessions.status.editing") });
    }
    if (session.phase === "responding") {
      return t("sessions.status.runningWith", { detail: t("sessions.status.responding") });
    }
    return t("sessions.status.running");
  }
  if (session.status === "failed") {
    return t("sessions.status.failed");
  }
  return t("sessions.status.idle");
}

export function sessionStatusLabel(status: string, t: Translate) {
  return translateStatus(aiSessionStatusKeys, status, t);
}

export function selectedAiSession(sessions: AiSessionSummary[] | undefined, selectedId?: string) {
  const sorted = sortedAiSessions(sessions);
  return sorted.find((session) => session.id === selectedId) || sorted[0];
}

export function displayAiSessionMessage(session: AiSessionSummary | undefined, promptIndex: number | undefined, t: Translate) {
  return displayAiSessionContent(session, promptIndex, true, t);
}

export function displayAiSessionResponse(session: AiSessionSummary | undefined, promptIndex: number | undefined, t: Translate) {
  return displayAiSessionContent(session, promptIndex, false, t);
}

function displayAiSessionContent(session: AiSessionSummary | undefined, promptIndex: number | undefined, includeProgress: boolean, t: Translate) {
  if (!session) {
    return includeProgress ? t("sessions.activity.noRecent") : "";
  }
  if (session.status === "waiting" && session.phase === "approval" && session.summary?.trim()) {
    return session.summary;
  }
  const turns = aiSessionDisplayTurns(session);
  if (turns.length && promptIndex !== undefined) {
    const index = Math.min(Math.max(promptIndex, 0), turns.length - 1);
    const turn = turns[index];
    if (turn?.status === "waiting" && turn.phase === "approval" && turn.summary?.trim()) {
      return turn.summary;
    }
    if (turn?.lastMessage?.trim()) {
      return turn.lastMessage;
    }
    if (turn?.summary?.trim()) {
      return turn.summary;
    }
    return includeProgress ? aiSessionProgressText(session, t) : "";
  }
  const latestTurn = turns.at(-1);
  if (latestTurn && !latestTurn.lastMessage?.trim() && !latestTurn.summary?.trim()) {
    return includeProgress ? aiSessionProgressText(session, t) : "";
  }
  if (session.lastMessage) {
    return session.lastMessage;
  }
  if (session.summary) {
    return session.summary;
  }
  if (session.error) {
    return session.error;
  }
  return includeProgress ? aiSessionProgressText(session, t) : "";
}

export function aiSessionUserPrompts(session?: AiSessionSummary) {
  if (!session) {
    return [];
  }
  return aiSessionDisplayTurns(session)
    .map((turn) => turn.userPrompt?.trim() || "")
    .filter(Boolean);
}

export function aiSessionTurns(session?: AiSessionSummary) {
  return (session?.turns || []).filter((turn) => turn.userPrompt?.trim() || turn.lastMessage?.trim() || turn.summary?.trim() || turn.contextCompactions?.length);
}

function aiSessionDisplayTurns(session?: AiSessionSummary) {
  return aiSessionTurns(session);
}

function aiSessionProgressText(session: AiSessionSummary, t: Translate) {
  if (session.currentTool?.name) {
    return `${t("sessions.status.running")} ${session.currentTool.name}${session.currentTool.inputPreview ? `: ${session.currentTool.inputPreview}` : ""}`;
  }
  if (session.status === "running") {
    return t("sessions.activity.running");
  }
  if (session.status === "waiting") {
    return session.phase === "approval" ? t("sessions.activity.waitingApproval") : t("sessions.activity.waiting");
  }
  return "-";
}

export function displayAiSessionTitle(session: AiSessionSummary | undefined, promptIndex: number | undefined, t: Translate) {
  if (!session) {
    return t("sessions.detail.noSelected");
  }
  const turns = aiSessionDisplayTurns(session);
  if (turns.length) {
    const index = promptIndex === undefined ? turns.length - 1 : Math.min(Math.max(promptIndex, 0), turns.length - 1);
    const turn = turns[index];
    return turn?.userPrompt?.trim() || (turn?.contextCompactions?.length ? "/compact" : "-");
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

export function aiSessionAppTab(instance: InstanceBoardItem | InstanceWithAiSessions, session?: AiSessionSummary) {
  if (!session) {
    return undefined;
  }
  const tabs = instance.apps.sessions.map((entry, index) => appSessionTab(entry, index)).filter((tab): tab is SessionTab => Boolean(tab));
  if (session.appSessionId) {
    const match = tabs.find((tab) => tab.key === session.appSessionId);
    if (match) {
      return match;
    }
  }
  const bindingKeys = new Set(session.appBindingKeys || []);
  return bindingKeys.size ? tabs.find((tab) => appSessionBindingKeys(tab.source).some((key) => bindingKeys.has(key))) : undefined;
}

export function aiSessionBasename(value?: string) {
  if (!value) {
    return "";
  }
  return value.split(/[\\/]/).filter(Boolean).at(-1) || value;
}

export function shortAiSessionId(value?: string) {
  if (!value) {
    return "";
  }
  return value.length > 12 ? value.slice(0, 12) : value;
}

export function relativeTime(value: string | undefined, locale: SupportedLocale) {
  if (!value) {
    return "-";
  }
  return formatRelativeTime(value, Date.now(), locale);
}

export function absoluteInstanceUrl(instance: InstanceBoardItem, path: string) {
  const webBase = instanceWebBase(instance);
  if (!webBase) {
    return "";
  }
  return joinInstancePath(instance, path);
}

export function activeAppLabel(instance: InstanceBoardItem, t: Translate) {
  const visibleSessions = instance.apps.sessions.filter(isVisibleAppSession);
  const session = visibleSessions[0];
  if (session && typeof session === "object" && "appId" in session && typeof session.appId === "string") {
    return session.appId;
  }
  return visibleSessions.length ? t("sessions.tabs.appSessions", { count: visibleSessions.length }) : t("sessions.tabs.noActiveApp");
}

export function previewTitle(instance: InstanceBoardItem, t: Translate) {
  if (instance.connectionStatus === "online") {
    return t("sessions.tabs.readyAttach");
  }
  if (instance.status === "registering") {
    return t("sessions.tabs.waitingRegistration");
  }
  if (instance.status === "created") {
    return t("sessions.tabs.createdNotStarted");
  }
  return instance.status;
}

export function previewDetail(instance: InstanceBoardItem, t: Translate, locale: SupportedLocale) {
  if (instanceWebBase(instance)) {
    return instanceWebBase(instance);
  }
  if (instance.lastHeartbeatAt) {
    return t("sessions.tabs.lastHeartbeat", { time: formatTime(instance.lastHeartbeatAt, locale) });
  }
  return t("sessions.tabs.workbenchHint");
}

export function heartbeatLabel(ageMs?: number) {
  if (ageMs === undefined) {
    return "no heartbeat";
  }
  if (ageMs < 60_000) {
    return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  }
  return `${Math.round(ageMs / 60_000)}m ago`;
}
