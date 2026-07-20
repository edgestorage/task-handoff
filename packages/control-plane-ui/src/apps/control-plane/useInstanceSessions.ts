import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../api/types";
import { appSessionBindingKeys, appSessionStatus, isVisibleAppSession } from "./appSessionVisibility.ts";

export type SessionTab = {
  key: string;
  label: string;
  title?: string;
  status: string;
  kind: "terminal" | "browser" | "logs" | "app" | "ai" | "status";
  source?: Record<string, unknown>;
  aiSessions?: AiSessionSummary[];
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

export function buildAppSessionTabs(instance?: InstanceBoardItem): SessionTab[] {
  if (!instance) {
    return [];
  }
  return instance.apps.sessions.map(appSessionTab).filter((session): session is SessionTab => Boolean(session));
}

export function buildSessionTabs(instance?: InstanceWithAiSessions): SessionTab[] {
  if (!instance) {
    return [];
  }
  const appSessions = buildAppSessionTabs(instance);
  const visibleAiSessions = aiSessionSnapshotSessions(instance.aiSessions);
  const aiSessionTab: SessionTab = {
    key: "ai-sessions",
    label: "AI Sessions",
    status: visibleAiSessions.some((session) => session.status === "waiting")
      ? "waiting"
      : visibleAiSessions.some((session) => session.status === "running")
        ? "running"
        : "idle",
    kind: "ai",
    aiSessions: visibleAiSessions,
  };
  const statusTab: SessionTab | undefined = instance.status === "running" ? undefined : {
    key: "overview",
    label: "Status",
    status: instance.status,
    kind: "status",
  };
  return [...(statusTab ? [statusTab] : []), aiSessionTab, ...appSessions];
}

function appSessionTab(session: Record<string, unknown>, index: number): SessionTab | undefined {
  if (!isVisibleAppSession(session)) {
    return undefined;
  }
  const appId = typeof session.appId === "string" ? session.appId : `App ${index + 1}`;
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

export function sessionFrameUrl(instance: InstanceBoardItem, session: SessionTab, options: { compact?: boolean } = {}) {
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
      query.set("view_only", "1");
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

export function appDisplayName(id: string) {
  const names: Record<string, string> = {
    "terminal-tty": "Terminal",
    "gui-terminal": "GUI Terminal",
    chromium: "Chromium",
    browser: "Browser",
    "vscode-web": "VS Code",
  };
  return names[id] || id.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function sessionDisplayName(session?: SessionTab) {
  return session ? session.title || appDisplayName(session.label) : "Session";
}

export function aiSessionAppDisplayName(appTab: SessionTab | undefined, fallback: string) {
  return appTab?.source ? sessionDisplayName(appTab) : fallback;
}

export function launchableAppsForInstance(instance: InstanceBoardItem): LaunchableApp[] {
  if (instance.connectionStatus !== "online" || !instance.appInventory) {
    return [];
  }
  return uniqueLaunchableApps(
    instance.appInventory.items
      .filter((app) => app.availability === "available")
      .map((app): LaunchableApp | undefined => {
        return {
          id: app.id,
          label: app.name || appDisplayName(app.id),
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

export function sessionMeta(session: SessionTab) {
  if (session.kind === "ai") {
    return aiSessionListHeadline(session.aiSessions || []);
  }
  const kind = sessionKindDisplayName(typeof session.source?.kind === "string" ? session.source.kind : session.kind);
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

export function groupedAppSessionTabs(instance: InstanceBoardItem, sessions: SessionTab[], activeSessionKey = ""): SessionWorkspaceGroup[] {
  const appSessions = sessions.filter((session) => session.kind !== "ai" && session.kind !== "status");
  const groups = new Map<string, SessionTab[]>();
  for (const session of appSessions) {
    const workspace = sessionWorkspacePath(session, instance);
    groups.set(workspace, [...(groups.get(workspace) || []), session]);
  }
  const activeWorkspace = appSessions.find((session) => session.key === activeSessionKey)
    ? sessionWorkspacePath(appSessions.find((session) => session.key === activeSessionKey) as SessionTab, instance)
    : "";
  return [...groups.entries()]
    .map(([label, groupSessions]) => ({
      key: label,
      label,
      sessions: [...groupSessions].sort((a, b) => Number(b.key === activeSessionKey) - Number(a.key === activeSessionKey)),
    }))
    .sort((a, b) => {
      const activeDelta = Number(b.key === activeWorkspace) - Number(a.key === activeWorkspace);
      return activeDelta || a.label.localeCompare(b.label);
    });
}

export function sessionWorkspacePath(session: SessionTab, instance: InstanceBoardItem) {
  if (session.kind === "ai") {
    return "AI Sessions";
  }
  if (session.kind === "status") {
    return "Status";
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
    || "Unknown workspace";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function sessionKindDisplayName(kind: string) {
  const labels: Record<string, string> = {
    tty: "Terminal",
    terminal: "Terminal",
    gui: "GUI",
    web: "Web",
    browser: "Browser",
    app: "App",
    logs: "Logs",
    ai: "AI",
  };
  return labels[kind] || appDisplayName(kind);
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

export function primaryAiSessionMessage(instance: InstanceWithAiSessions) {
  return displayAiSessionMessage(primaryAiSession(instance));
}

export function aiSessionHeadline(instance: InstanceBoardItem | InstanceWithAiSessions) {
  const snapshot = instance.aiSessions;
  if (snapshot) {
    const headline = aiSessionSnapshotHeadline(snapshot);
    return headline === "0 active · 0 idle · 0 waiting" ? "AI activity" : `AI ${headline}`;
  }
  return "AI activity";
}

export function aiSessionSnapshotHeadline(snapshot: InstanceBoardItem["aiSessions"] | InstanceWithAiSessions["aiSessions"]) {
  if (!snapshot) {
    return "0 active · 0 idle · 0 waiting";
  }
  const counts = aiSessionCounts(snapshot);
  const parts = [];
  if (counts.active) {
    parts.push(`${counts.active} active`);
  }
  if (counts.idle) {
    parts.push(`${counts.idle} idle`);
  }
  if (counts.waiting) {
    parts.push(`${counts.waiting} waiting`);
  }
  return parts.length ? parts.join(" · ") : "0 active · 0 idle · 0 waiting";
}

export function aiSessionListHeadline(sessions: AiSessionSummary[]) {
  const counts = aiSessionCounts({ sessions });
  return [
    `${counts.active} active`,
    counts.idle ? `${counts.idle} idle` : "",
    `${counts.waiting} waiting`,
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

export function selectedAiSession(sessions: AiSessionSummary[] | undefined, selectedId?: string) {
  const sorted = sortedAiSessions(sessions);
  return sorted.find((session) => session.id === selectedId) || sorted[0];
}

export function displayAiSessionMessage(session?: AiSessionSummary, promptIndex?: number) {
  return displayAiSessionContent(session, promptIndex, true);
}

export function displayAiSessionResponse(session?: AiSessionSummary, promptIndex?: number) {
  return displayAiSessionContent(session, promptIndex, false);
}

function displayAiSessionContent(session?: AiSessionSummary, promptIndex?: number, includeProgress = true) {
  if (!session) {
    return includeProgress ? "No recent AI activity" : "";
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
    return includeProgress ? aiSessionProgressText(session) : "";
  }
  const latestTurn = turns.at(-1);
  if (latestTurn && !latestTurn.lastMessage?.trim() && !latestTurn.summary?.trim()) {
    return includeProgress ? aiSessionProgressText(session) : "";
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
  return includeProgress ? aiSessionProgressText(session) : "";
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

function aiSessionProgressText(session: AiSessionSummary) {
  if (session.currentTool?.name) {
    return `Running ${session.currentTool.name}${session.currentTool.inputPreview ? `: ${session.currentTool.inputPreview}` : ""}`;
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
  const tabs = instance.apps.sessions.map(appSessionTab).filter((tab): tab is SessionTab => Boolean(tab));
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

export function relativeTime(value?: string) {
  if (!value) {
    return "unknown";
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

export function absoluteInstanceUrl(instance: InstanceBoardItem, path: string) {
  const webBase = instanceWebBase(instance);
  if (!webBase) {
    return "";
  }
  return joinInstancePath(instance, path);
}

export function activeAppLabel(instance: InstanceBoardItem) {
  const visibleSessions = instance.apps.sessions.filter(isVisibleAppSession);
  const session = visibleSessions[0];
  if (session && typeof session === "object" && "appId" in session && typeof session.appId === "string") {
    return session.appId;
  }
  return visibleSessions.length ? `${visibleSessions.length} app sessions` : "No active app";
}

export function previewTitle(instance: InstanceBoardItem) {
  if (instance.connectionStatus === "online") {
    return "Ready to attach";
  }
  if (instance.status === "registering") {
    return "Waiting for registration";
  }
  if (instance.status === "created") {
    return "Created, not started";
  }
  return instance.status;
}

export function previewDetail(instance: InstanceBoardItem) {
  if (instanceWebBase(instance)) {
    return instanceWebBase(instance);
  }
  if (instance.lastHeartbeatAt) {
    return `last heartbeat ${new Date(instance.lastHeartbeatAt).toLocaleTimeString()}`;
  }
  return "Create or register a controlled instance to make this workbench live.";
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
