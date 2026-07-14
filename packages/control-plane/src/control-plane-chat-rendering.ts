import type { AppAccessMode } from "./app-access-service.ts";
import type { AiSessionActionResult } from "@task-handoff/protocol/ai-sessions";
import { isVisibleAppSessionStatus } from "./app-session-visibility.ts";
import type { ChatBoardInstance } from "./control-plane-chat-types.ts";

export function aiSessionActionTurnId(value: AiSessionActionResult) {
  return value.turnId || value.providerTurnId || value.session.activeTurnId || "";
}

export function aiSessionActionProviderTurnId(value: AiSessionActionResult) {
  return value.providerTurnId || value.turnId || "";
}

export function renderAppSessionsReply(sessionCount: number, buttonCount: number) {
  if (sessionCount === 0) {
    return "No app sessions found.";
  }
  if (buttonCount === 0) {
    return `App sessions: ${sessionCount}. Set the control plane public URL in Settings > Appearance to open them from chat.`;
  }
  return `App sessions: ${sessionCount}. Tap a button to open.`;
}

export function renderInstancesReply(instanceCount: number) {
  if (instanceCount === 0) {
    return "No controlled instances are registered yet.";
  }
  return `Instances: ${instanceCount}. Tap an instance to create an app.`;
}

export function isVisibleAppSession(session: Record<string, unknown>) {
  return isVisibleAppSessionStatus(stringValue(session.status));
}

export function appSessionButtonLabel(instance: ChatBoardInstance, session: Record<string, unknown>) {
  const appId = stringValue(session.appId) || "App";
  const title = stringValue(session.title).trim();
  if (title && title !== appId) {
    return title;
  }
  const catalogName = appCatalogName(instance, appId);
  if (catalogName) {
    return catalogName;
  }
  return appId;
}

export function launchableAppsForInstance(instance: ChatBoardInstance) {
  const apps = launchableAppValues(instance);
  const byId = new Map<string, { id: string; label: string }>();
  for (const app of apps) {
    const item = launchableAppFromValue(app);
    if (item && !byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export function instanceAppMenuCallbackData(token: string) {
  return `task_handoff:cp_i:${token}`;
}

export function launchAppCallbackData(token: string) {
  return `task_handoff:cp_a:${token}`;
}

export function appSessionLink(instance: ChatBoardInstance, session: Record<string, unknown>, publicBaseUrl: string | undefined, createToken: () => string) {
  const id = stringValue(session.id);
  const relative = id ? appSessionAccessPath(session, createToken) : `/instances/${encodeURIComponent(instance.id)}/`;
  const absolute = absoluteControlPlaneUrl(relative, publicBaseUrl);
  return {
    text: absolute || relative,
    url: absolute,
  };
}

export function appSessionAccessMode(session: Record<string, unknown>): AppAccessMode {
  const kind = stringValue(session.kind);
  if (kind === "gui") {
    return "vnc";
  }
  if (kind === "web") {
    return "web";
  }
  return "tty";
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appCatalogName(instance: ChatBoardInstance, appId: string) {
  for (const app of instance.appInventory?.items || []) {
    if (app.id === appId) {
      return app.name;
    }
  }
  return "";
}

function launchableAppValues(instance: ChatBoardInstance) {
  if (instance.connectionStatus !== "online") return [];
  return (instance.appInventory?.items || []).filter((app) => app.availability === "available");
}

function launchableAppFromValue(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return { id: value, label: appDisplayName(value) };
  }
  const record = objectRecord(value);
  const id = stringValue(record.id).trim();
  if (!id) {
    return undefined;
  }
  const name = stringValue(record.name).trim();
  return { id, label: name || appDisplayName(id) };
}

function appDisplayName(id: string) {
  const names: Record<string, string> = {
    "terminal-tty": "Terminal",
    "gui-terminal": "GUI Terminal",
    chromium: "Chromium",
    browser: "Browser",
    "vscode-web": "VS Code",
  };
  return names[id] || id.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function appSessionAccessPath(session: Record<string, unknown>, createToken: () => string) {
  const mode = appSessionAccessMode(session);
  const token = encodeURIComponent(createToken());
  return `/apps/access/${mode}?token=${token}`;
}

function absoluteControlPlaneUrl(pathname: string, publicBaseUrl: string | undefined) {
  const base = stringValue(publicBaseUrl);
  if (!base || !new RegExp("^https?://", "i").test(base)) {
    return undefined;
  }
  return new URL(pathname, base.endsWith("/") ? base : base + "/").toString();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
