import { defineStore } from "pinia";
import type { AppSession } from "../api/types";

const STORAGE_KEY = "task-handoff-workspace-tabs";
const SETTINGS_KEY = "task-handoff-workspace-settings";

export type VncResizeMode = "scale" | "remote";

export type WorkspaceTab =
  | { type: "ai-sessions"; id: string; title: string }
  | { type: "app-vnc"; id: string; sessionId: string; title: string }
  | { type: "shared-vnc"; id: string; sessionId: string; displaySessionId: string; title: string }
  | { type: "app-web"; id: string; sessionId: string; title: string }
  | { type: "app-tty"; id: string; sessionId: string; title: string }
  | { type: "logs"; id: string; sessionId: string; title: string };

export const AI_SESSIONS_TAB: WorkspaceTab = { type: "ai-sessions", id: "ai-sessions", title: "AI Sessions" };

export function workspaceTabForSession(session: AppSession): WorkspaceTab {
  if (session.kind === "gui") {
    const displaySessionId = sharedDisplaySessionId(session);
    if (displaySessionId) {
      return {
        type: "shared-vnc",
        id: `shared-vnc:${displaySessionId}`,
        sessionId: session.id,
        displaySessionId,
        title: sharedDisplayTitle(displaySessionId),
      };
    }
    return { type: "app-vnc", id: `vnc:${session.id}`, sessionId: session.id, title: session.title };
  }
  if (session.kind === "web") {
    return { type: "app-web", id: `web:${session.id}`, sessionId: session.id, title: session.title };
  }
  return { type: "app-tty", id: `tty:${session.id}`, sessionId: session.id, title: session.title };
}

export function sessionForWorkspaceTab(tab: WorkspaceTab | undefined, sessions: AppSession[]) {
  if (!tab) {
    return undefined;
  }
  if (tab.type === "ai-sessions") {
    return undefined;
  }
  if (tab.type === "shared-vnc") {
    return (
      latestSession(
        sessions.filter(
          (session) =>
            session.status === "running" &&
            session.kind === "gui" &&
            Boolean(session.vnc) &&
            sharedDisplaySessionId(session) === tab.displaySessionId,
        ),
      ) || sessions.find((session) => session.id === tab.sessionId)
    );
  }
  return sessions.find((session) => session.id === tab.sessionId);
}

export function sharedDisplayIdsForSessions(sessions: AppSession[]) {
  return new Set(
    sessions
      .map((session) => (session.status === "running" ? sharedDisplaySessionId(session) : undefined))
      .filter((id): id is string => Boolean(id)),
  );
}

function sharedDisplaySessionId(session: AppSession) {
  return session.display?.mode === "shared" ? session.display.displaySessionId || "main" : undefined;
}

function sharedDisplayTitle(displaySessionId: string) {
  return displaySessionId === "main" ? "Shared Screen" : `Shared ${displaySessionId}`;
}

function latestSession(sessions: AppSession[]) {
  return [...sessions].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];
}

function loadTabs(): WorkspaceTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTabs(tabs: WorkspaceTab[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      guiHidpi: typeof parsed.guiHidpi === "boolean" ? parsed.guiHidpi : true,
    };
  } catch {
    return { guiHidpi: true };
  }
}

function saveSettings(settings: { guiHidpi: boolean }) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    tabs: loadTabs(),
    activeTabId: loadTabs()[0]?.id || "",
    vncResizeMode: "scale" as VncResizeMode,
    guiHidpi: loadSettings().guiHidpi,
  }),
  actions: {
    open(tab: WorkspaceTab) {
      const existing = this.tabs.find((item) => item.id === tab.id);
      if (existing) {
        Object.assign(existing, tab);
      } else {
        this.tabs.push(tab);
      }
      this.activeTabId = tab.id;
      saveTabs(this.tabs);
    },
    close(tabId: string) {
      const index = this.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) {
        return;
      }
      this.tabs.splice(index, 1);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs[Math.max(0, index - 1)]?.id || this.tabs[0]?.id || "";
      }
      saveTabs(this.tabs);
    },
    setActive(tabId: string) {
      if (this.tabs.some((tab) => tab.id === tabId)) {
        this.activeTabId = tabId;
      }
    },
    setVncResizeMode(mode: VncResizeMode) {
      this.vncResizeMode = mode;
    },
    setGuiHidpi(enabled: boolean) {
      this.guiHidpi = enabled;
      saveSettings({ guiHidpi: this.guiHidpi });
    },
    moveTab(tabId: string, targetTabId: string, placement: "before" | "after" = "before") {
      if (tabId === targetTabId) {
        return;
      }
      const fromIndex = this.tabs.findIndex((tab) => tab.id === tabId);
      if (fromIndex === -1 || !this.tabs.some((tab) => tab.id === targetTabId)) {
        return;
      }
      const [tab] = this.tabs.splice(fromIndex, 1);
      const targetIndex = this.tabs.findIndex((item) => item.id === targetTabId);
      const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
      this.tabs.splice(insertIndex, 0, tab);
      saveTabs(this.tabs);
    },
    syncSessionTitles(sessions: AppSession[]) {
      const titlesBySessionId = new Map(sessions.map((session) => [session.id, session.title]));
      let changed = false;
      for (const tab of this.tabs) {
        if (tab.type === "ai-sessions" || tab.type === "shared-vnc") {
          continue;
        }
        const sessionTitle = titlesBySessionId.get(tab.sessionId);
        if (!sessionTitle) {
          continue;
        }
        const title = tab.type === "logs" ? `${sessionTitle} logs` : sessionTitle;
        if (tab.title !== title) {
          tab.title = title;
          changed = true;
        }
      }
      if (changed) {
        saveTabs(this.tabs);
      }
    },
    pruneSession(sessionIds: Set<string>, sharedDisplayIds = new Set<string>()) {
      const next = this.tabs.filter((tab) =>
        tab.type === "ai-sessions"
          ? true
          : tab.type === "shared-vnc"
            ? sharedDisplayIds.has(tab.displaySessionId) || sessionIds.has(tab.sessionId)
            : sessionIds.has(tab.sessionId),
      );
      if (next.length !== this.tabs.length) {
        this.tabs = next;
        if (!this.tabs.some((tab) => tab.id === this.activeTabId)) {
          this.activeTabId = this.tabs[0]?.id || "";
        }
        saveTabs(this.tabs);
      }
    },
  },
});
