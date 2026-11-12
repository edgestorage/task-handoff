import { ref } from "vue";
import type { DesktopSource } from "@task-handoff/protocol/remote-desktop";
import type { SelectedSourceIdentity } from "./remoteDesktopSourceSelection.ts";

export type SessionRemoteDesktopTarget = SelectedSourceIdentity & {
  sourceRef?: string;
};

export type SessionRemoteDesktopLink = {
  target: SessionRemoteDesktopTarget;
  openedAt: number;
  lastUsedAt: number;
};

type SessionRemoteDesktopLinks = {
  bySession: Record<string, SessionRemoteDesktopLink>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "task-handoff.control-plane.remote-desktop-session-links";
const STORAGE_VERSION = 1;

export const sessionRemoteDesktopLinks = ref<SessionRemoteDesktopLinks>(loadSessionRemoteDesktopLinks());

export function sessionRemoteDesktopLinkKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

export function sessionRemoteDesktopLinkFor(instanceId: string, sessionId: string) {
  return sessionRemoteDesktopLinks.value.bySession[sessionRemoteDesktopLinkKey(instanceId, sessionId)];
}

export function rememberSessionRemoteDesktopLink(input: {
  instanceId: string;
  sessionId: string;
  target: SessionRemoteDesktopTarget;
  at?: number;
  storage?: StorageLike;
}) {
  const key = sessionRemoteDesktopLinkKey(input.instanceId, input.sessionId);
  const current = sessionRemoteDesktopLinks.value.bySession[key];
  const at = input.at ?? Date.now();
  const next = {
    bySession: {
      ...sessionRemoteDesktopLinks.value.bySession,
      [key]: {
        target: sanitizeSessionRemoteDesktopTarget(input.target),
        openedAt: current?.openedAt ?? at,
        lastUsedAt: at,
      },
    },
  };
  sessionRemoteDesktopLinks.value = next;
  persistSessionRemoteDesktopLinks(next, input.storage);
}

export function touchSessionRemoteDesktopLink(instanceId: string, sessionId: string, at = Date.now()) {
  const key = sessionRemoteDesktopLinkKey(instanceId, sessionId);
  const current = sessionRemoteDesktopLinks.value.bySession[key];
  if (!current) return;
  const next = {
    bySession: {
      ...sessionRemoteDesktopLinks.value.bySession,
      [key]: { ...current, lastUsedAt: at },
    },
  };
  sessionRemoteDesktopLinks.value = next;
  persistSessionRemoteDesktopLinks(next);
}

export function removeSessionRemoteDesktopLink(instanceId: string, sessionId: string) {
  const key = sessionRemoteDesktopLinkKey(instanceId, sessionId);
  if (!(key in sessionRemoteDesktopLinks.value.bySession)) return;
  const bySession = { ...sessionRemoteDesktopLinks.value.bySession };
  delete bySession[key];
  const next = { bySession };
  sessionRemoteDesktopLinks.value = next;
  persistSessionRemoteDesktopLinks(next);
}

export function sessionRemoteDesktopTargetFromSource(source: DesktopSource): SessionRemoteDesktopTarget {
  return {
    kind: source.kind,
    sourceRef: source.sourceRef,
    title: source.title,
    subtitle: source.subtitle,
    width: source.width,
    height: source.height,
  };
}

export function sessionRemoteDesktopSourceIdentity(target: SessionRemoteDesktopTarget | undefined): SelectedSourceIdentity | undefined {
  if (!target) return undefined;
  return {
    kind: target.kind,
    title: target.title,
    subtitle: target.subtitle,
    width: target.width,
    height: target.height,
  };
}

export function sanitizeSessionRemoteDesktopTarget(value: unknown): SessionRemoteDesktopTarget {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = typeof record.kind === "string" && record.kind.trim() && record.kind.trim().length <= 64
    ? record.kind.trim()
    : "display";
  const title = typeof record.title === "string" && record.title.trim()
    ? record.title.trim().slice(0, 512)
    : "Entire desktop";
  const subtitle = typeof record.subtitle === "string" ? record.subtitle.trim().slice(0, 256) : null;
  const width = Number.isSafeInteger(record.width) && Number(record.width) >= 0 ? Number(record.width) : 0;
  const height = Number.isSafeInteger(record.height) && Number(record.height) >= 0 ? Number(record.height) : 0;
  const sourceRef = typeof record.sourceRef === "string" && record.sourceRef.trim().length <= 4096
    ? record.sourceRef.trim()
    : "";
  return {
    kind,
    title,
    subtitle,
    width,
    height,
    ...(sourceRef ? { sourceRef } : {}),
  };
}

export function parseSessionRemoteDesktopLinks(raw: string | null | undefined): SessionRemoteDesktopLinks {
  if (!raw) return { bySession: {} };
  try {
    const value = JSON.parse(raw) as { version?: unknown; bySession?: unknown };
    if (value.version !== STORAGE_VERSION || !value.bySession || typeof value.bySession !== "object" || Array.isArray(value.bySession)) {
      return { bySession: {} };
    }
    const bySession: Record<string, SessionRemoteDesktopLink> = {};
    for (const [key, candidate] of Object.entries(value.bySession as Record<string, unknown>)) {
      if (!key || !candidate || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      if (!record.target || typeof record.target !== "object") continue;
      const openedAt = timestamp(record.openedAt);
      if (openedAt === undefined) continue;
      bySession[key] = {
        target: sanitizeSessionRemoteDesktopTarget(record.target),
        openedAt,
        lastUsedAt: timestamp(record.lastUsedAt) ?? openedAt,
      };
    }
    return { bySession };
  } catch {
    return { bySession: {} };
  }
}

function loadSessionRemoteDesktopLinks() {
  if (typeof window === "undefined") return { bySession: {} };
  try {
    return parseSessionRemoteDesktopLinks(window.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return { bySession: {} };
  }
}

function persistSessionRemoteDesktopLinks(value: SessionRemoteDesktopLinks, storage?: StorageLike) {
  const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!target) return;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...value }));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function timestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
