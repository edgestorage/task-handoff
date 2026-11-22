import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import { launchAppSession, markAiSessionRead, stopAppSession } from "../../../api/queries";
import type { AiSessionSummary, InstanceBoardItem, InstanceBoardItemWithAppSessions, InstanceWithAiSessions } from "../../../api/types";
import {
  aiSessionAppTab,
  appDisplayName,
  absoluteInstanceUrl,
  buildSessionTabs,
  EMBEDDED_BROWSER_APP_ID,
  launchableAppsForInstance,
  REMOTE_DESKTOP_APP_ID,
  sessionFrameUrl,
  sessionTerminalSocketUrl,
  uniqueLaunchableApps,
  type SessionTab,
  type RepositoryWorkspaceTabTarget,
} from "../useInstanceSessions";
import { hasInstanceStatusPage, isInstanceAppReady, isInstanceConnecting } from "../useInstanceStatus";
import { reorderSessionTabKeys } from "./sessionTabOrder";
import type { Translate } from "../../../i18n/status";
import { supportsBrowserTunnel } from "@task-handoff/protocol/control-plane";
import { supportsDirectoryBrowserTunnel } from "@task-handoff/protocol/control-plane-directory";
import { canUseDesktopBrowserContext } from "../../../lib/desktopBridge";
import { createBrowserUuid } from "../../../lib/random-id";
import { ApiError } from "../../../api/client";
import { remoteDesktopAvailable } from "../remoteDesktopCapability";
import { CLOSE_SESSION_REMOTE_DESKTOP_EVENT, OPEN_SESSION_REMOTE_DESKTOP_EVENT, type CloseSessionRemoteDesktopDetail, type OpenSessionRemoteDesktopDetail } from "./sessionRemoteDesktopEvents";
import { moveBrowserPageToSlot, type BrowserPageSurface, type BrowserTabSlot } from "./browserPageTabs";
export type { BrowserPageSurface } from "./browserPageTabs";
import {
  removeSessionRemoteDesktopLink,
  rememberSessionRemoteDesktopLink,
  sessionRemoteDesktopLinkFor,
  touchSessionRemoteDesktopLink,
} from "./sessionRemoteDesktopLinks";

export type SessionPaneId = "left" | "right";

export type BrowserPageRecord = BrowserPageSurface & {
  key: string;
  title: string;
  status: string;
};

const BROWSER_TAB_SLOT_PREFIX = "embedded-browser:";
const BROWSER_PAGE_PREFIX = "embedded-browser-page:";

const REMOTE_DESKTOP_TABS_STORAGE_KEY = "task-handoff.control-plane.remote-desktop-tabs";

function loadRemoteDesktopSessionTabs(t: Translate): Record<string, SessionTab[]> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(REMOTE_DESKTOP_TABS_STORAGE_KEY) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const tabs: Record<string, SessionTab[]> = {};
    for (const [instanceId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!instanceId || !Array.isArray(value)) continue;
      const instanceTabs = value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.key !== "string" || !item.key.startsWith(`${REMOTE_DESKTOP_APP_ID}:${instanceId}`)) return [];
        const aiSessionId = typeof item.aiSessionId === "string" && item.aiSessionId ? item.aiSessionId : undefined;
        const key = aiSessionId ? `${REMOTE_DESKTOP_APP_ID}:${instanceId}:${aiSessionId}` : `${REMOTE_DESKTOP_APP_ID}:${instanceId}`;
        return [{
          key,
          kind: "remote-desktop" as const,
          label: REMOTE_DESKTOP_APP_ID,
          title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : t("instances.remoteDesktop.title"),
          status: "running",
          ...(aiSessionId ? { source: { aiSessionId } } : {}),
        }];
      });
      if (instanceTabs.length) tabs[instanceId] = instanceTabs;
    }
    return tabs;
  } catch {
    return {};
  }
}

function persistRemoteDesktopSessionTabs(tabs: Record<string, SessionTab[]>) {
  if (typeof window === "undefined") return;
  try {
    const value = Object.fromEntries(Object.entries(tabs).flatMap(([instanceId, instanceTabs]) => {
      const remoteTabs = instanceTabs
        .filter((tab) => tab.kind === "remote-desktop")
        .map((tab) => ({
          key: tab.key,
          ...(tab.title ? { title: tab.title } : {}),
          ...(typeof tab.source?.aiSessionId === "string" ? { aiSessionId: tab.source.aiSessionId } : {}),
        }));
      return remoteTabs.length ? [[instanceId, remoteTabs]] : [];
    }));
    window.localStorage?.setItem(REMOTE_DESKTOP_TABS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

type UseActiveInstanceSessionsInput = {
  activeInstance: ComputedRef<InstanceWithAiSessions | undefined>;
  routeSessionRemoteDesktop?: (detail: OpenSessionRemoteDesktopDetail) => boolean;
  boardSessionKeys: Record<string, string>;
  canInteractRemoteDesktop: Ref<boolean>;
  closeFloatingLayers: (except?: "instance" | "session" | "app") => void;
  errorText: (error: unknown) => string;
  focusAppSession?: (instance: InstanceBoardItem, sessionId: string) => void | Promise<void>;
  notifyError?: (message: string) => void;
  refresh: () => Promise<void>;
  appLaunchMenuOpen: Ref<boolean>;
  sessionMenuOpen: Ref<boolean>;
  t: Translate;
};

export function useActiveInstanceSessions({
  activeInstance,
  appLaunchMenuOpen,
  boardSessionKeys,
  canInteractRemoteDesktop,
  closeFloatingLayers,
  errorText,
  focusAppSession,
  notifyError,
  refresh,
  routeSessionRemoteDesktop,
  sessionMenuOpen,
  t,
}: UseActiveInstanceSessionsInput) {
  const launchingApp = ref(false);
  const stoppingSessionId = ref("");
  const selectedSessionKeys = reactive<Record<string, string>>({});
  const rightSelectedSessionKeys = reactive<Record<string, string>>({});
  const focusedSessionPanes = reactive<Record<string, SessionPaneId>>({});
  const rightPaneSessionKeys = reactive<Record<string, Record<string, true>>>({});
  const sessionSplitRatios = reactive<Record<string, number>>({});
  const recentSessionKeys = reactive<Record<string, string[]>>({});
  const sessionTabOrderKeys = reactive<Record<string, string[]>>({});
  const selectedAiSessionKeys = reactive<Record<string, string>>({});
  const selectedAiSessionSnapshots = reactive<Record<string, AiSessionSummary | undefined>>({});
  const repositorySessionTabs = reactive<Record<string, SessionTab[]>>({});
  const browserPages = reactive<Record<string, BrowserPageRecord[]>>({});
  const browserTabSlots = reactive<Record<string, BrowserTabSlot[]>>({});
  const remoteDesktopSessionTabs = reactive<Record<string, SessionTab[]>>(loadRemoteDesktopSessionTabs(t));
  const pendingAiSessionAppSelections = new Map<string, AiSessionSummary>();

  const remoteDesktopEnabled = computed(() => Boolean(
    activeInstance.value
    && canInteractRemoteDesktop.value
    && remoteDesktopAvailable(activeInstance.value),
  ));

  const browserSessionTabs = computed<Record<string, SessionTab[]>>(() => {
    const tabs: Record<string, SessionTab[]> = {};
    for (const [instanceId, slots] of Object.entries(browserTabSlots)) {
      const pages = new Map((browserPages[instanceId] || []).map((page) => [page.key, page]));
      tabs[instanceId] = slots.map((slot) => {
        const page = pages.get(slot.pageKey);
        return {
          key: slot.key,
          kind: "embedded-browser" as const,
          label: EMBEDDED_BROWSER_APP_ID,
          title: page?.title || t("sessions.tabs.embeddedBrowser"),
          status: page?.status || "running",
          source: {
            pageKey: slot.pageKey,
            ...(page?.initialUrl ? { initialUrl: page.initialUrl } : {}),
            ...(page?.currentUrl ? { currentUrl: page.currentUrl } : {}),
            ...(page?.creationRef ? { creationRef: page.creationRef } : {}),
          },
        };
      });
    }
    return tabs;
  });
  const sessionTabs = computed(() => {
    const instanceId = activeInstance.value?.id;
    const instanceTabs = buildSessionTabs(activeInstance.value, t);
    return instanceTabs.some((session) => session.kind === "status")
      ? instanceTabs
      : [
          ...instanceTabs,
          ...(instanceId ? repositorySessionTabs[instanceId] || [] : []),
          ...(instanceId ? browserSessionTabs.value[instanceId] || [] : []),
          ...(instanceId && remoteDesktopEnabled.value ? remoteDesktopSessionTabs[instanceId] || [] : []),
        ];
  });
  const browserSurfaceState = computed<Record<string, {
    leftSessionKey: string;
    rightSessionKey: string;
  }>>(() => {
    const state: Record<string, {
      leftSessionKey: string;
      rightSessionKey: string;
    }> = {};
    const instanceIds = new Set([...Object.keys(browserSessionTabs.value), ...Object.keys(remoteDesktopSessionTabs)]);
    for (const instanceId of instanceIds) {
      state[instanceId] = {
        leftSessionKey: selectedSessionKeys[instanceId] || "",
        rightSessionKey: rightSelectedSessionKeys[instanceId] || "",
      };
    }
    return state;
  });
  const orderedSessionTabs = computed(() => {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) {
      return sessionTabs.value;
    }
    return orderedTabsForInstance(instanceId, sessionTabs.value);
  });
  const leftSessionKey = computed({
    get() {
      const instanceId = activeInstance.value?.id;
      return instanceId ? selectedSessionKeys[instanceId] || "overview" : "overview";
    },
    set(sessionKey: string) {
      const instanceId = activeInstance.value?.id;
      if (instanceId) {
        selectedSessionKeys[instanceId] = sessionKey;
      }
    },
  });
  const rightSessionKey = computed({
    get() {
      const instanceId = activeInstance.value?.id;
      return instanceId ? rightSelectedSessionKeys[instanceId] || "" : "";
    },
    set(sessionKey: string) {
      const instanceId = activeInstance.value?.id;
      if (instanceId) rightSelectedSessionKeys[instanceId] = sessionKey;
    },
  });
  const focusedSessionPane = computed<SessionPaneId>(() => {
    const instanceId = activeInstance.value?.id;
    return instanceId ? focusedSessionPanes[instanceId] || "left" : "left";
  });
  const activeSessionKey = computed({
    get() {
      return focusedSessionPane.value === "right" && rightSessionKey.value ? rightSessionKey.value : leftSessionKey.value;
    },
    set(sessionKey: string) {
      if (focusedSessionPane.value === "right" && rightSessionKey.value) rightSessionKey.value = sessionKey;
      else leftSessionKey.value = sessionKey;
    },
  });
  const leftOrderedSessionTabs = computed(() => orderedSessionTabs.value.filter((session) => sessionPane(session) === "left"));
  const rightOrderedSessionTabs = computed(() => orderedSessionTabs.value.filter((session) => sessionPane(session) === "right"));
  const hasSessionSplit = computed(() => rightOrderedSessionTabs.value.length > 0);
  const sessionSplitRatio = computed(() => {
    const instanceId = activeInstance.value?.id;
    return instanceId ? sessionSplitRatios[instanceId] || 0.5 : 0.5;
  });
  const leftSession = computed(() => sessionTabs.value.find((session) => session.key === leftSessionKey.value) || leftOrderedSessionTabs.value[0]);
  const rightSession = computed(() => sessionTabs.value.find((session) => session.key === rightSessionKey.value));
  const activeSession = computed(() => sessionTabs.value.find((session) => session.key === activeSessionKey.value) || sessionTabs.value[0]);
  const activeSessionFrameUrl = computed(() => (activeInstance.value && activeSession.value ? sessionFrameUrl(activeInstance.value, activeSession.value) : ""));
  const activeTerminalSocketUrl = computed(() => (activeInstance.value && activeSession.value ? sessionTerminalSocketUrl(activeInstance.value, activeSession.value) : ""));
  const activeInstanceWebUrl = computed(() => (activeInstance.value ? absoluteInstanceUrl(activeInstance.value, "/") : ""));
  const activeOpenUrl = computed(() => activeSessionFrameUrl.value || (!activeTerminalSocketUrl.value ? activeInstanceWebUrl.value : ""));
  const activeAttachUrl = computed(() => (activeTerminalSocketUrl.value ? activeInstanceWebUrl.value : ""));
  const activeInstanceConnecting = computed(() => Boolean(activeInstance.value && isInstanceConnecting(activeInstance.value)));
  const canLaunchApp = computed(() => Boolean(activeInstance.value && isInstanceAppReady(activeInstance.value)));
  const appLaunchButtonLabel = computed(() => {
    if (launchingApp.value) {
      return t("sessions.tabs.launching");
    }
    if (activeInstanceConnecting.value) {
      return t("sessions.tabs.connecting");
    }
    if (activeInstance.value && activeInstance.value.connectionStatus !== "online") {
      return t("sessions.tabs.offline");
    }
    return t("sessions.tabs.app");
  });
  const appLaunchButtonTitle = computed(() =>
    activeInstance.value && !isInstanceAppReady(activeInstance.value)
      ? t("sessions.tabs.launchUnavailable")
      : t("sessions.tabs.launchApp"),
  );
  const launchableApps = computed(() => {
    if (!activeInstance.value) {
      return [];
    }
    const remoteDesktopApps = remoteDesktopEnabled.value
      ? [{
          id: REMOTE_DESKTOP_APP_ID,
          label: t("instances.remoteDesktop.title"),
          description: t("instances.remoteDesktop.chooseTargetHint"),
          kind: "gui" as const,
        }]
      : [];
    const browser = canUseDesktopBrowserContext()
      && (supportsBrowserTunnel(activeInstance.value.capabilities) || supportsDirectoryBrowserTunnel(activeInstance.value.capabilities))
      ? [{ id: EMBEDDED_BROWSER_APP_ID, label: t("sessions.tabs.embeddedBrowser") }]
      : [];
    const catalogApps = launchableAppsForInstance(activeInstance.value, t);
    if (catalogApps.length) return uniqueLaunchableApps([...remoteDesktopApps, ...catalogApps, ...browser]);
    const ids = activeInstance.value.image?.optionalApps?.length ? activeInstance.value.image.optionalApps : ["terminal-tty"];
    return uniqueLaunchableApps([...remoteDesktopApps, ...ids.map((id) => ({ id, label: appDisplayName(id, t) })), ...browser]);
  });

  watch(
    () => activeInstance.value?.id,
    () => {
      if (activeInstance.value && hasInstanceStatusPage(activeInstance.value)) {
        selectedSessionKeys[activeInstance.value.id] = "overview";
        focusedSessionPanes[activeInstance.value.id] = "left";
      }
      normalizeSessionLayout();
    },
  );

  watch(
    () => Boolean(activeInstance.value && hasInstanceStatusPage(activeInstance.value)),
    (hasStatusPage, hadStatusPage) => {
      if (hasStatusPage && !hadStatusPage && activeInstance.value) {
        selectedSessionKeys[activeInstance.value.id] = "overview";
        focusedSessionPanes[activeInstance.value.id] = "left";
        closeSessionSplit();
      }
    },
  );

  watch(
    () => [activeInstance.value?.id || "", sessionTabs.value.map((session) => session.key).join("\n")] as const,
    () => {
      if (!sessionTabs.value.length) {
        leftSessionKey.value = "overview";
        sessionMenuOpen.value = false;
        pruneSessionTabOrder();
        return;
      }
      pruneSessionTabOrder();
      normalizeSessionLayout();
      applyPendingAiSessionAppSelection();
    },
  );

  function isPinnedLeft(session: SessionTab) {
    return session.kind === "ai" || session.kind === "status";
  }

  function sessionPane(session: SessionTab): SessionPaneId {
    const instanceId = activeInstance.value?.id;
    if (!instanceId || isPinnedLeft(session)) return "left";
    return rightPaneSessionKeys[instanceId]?.[session.key] ? "right" : "left";
  }

  function ensurePaneAssignments(instanceId: string) {
    return rightPaneSessionKeys[instanceId] ||= reactive<Record<string, true>>({});
  }

  function normalizeSessionLayout() {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) return;
    const assignments = ensurePaneAssignments(instanceId);
    const availableKeys = new Set(sessionTabs.value.map((session) => session.key));
    for (const key of Object.keys(assignments)) {
      const session = sessionTabs.value.find((item) => item.key === key);
      if (!availableKeys.has(key) || !session || isPinnedLeft(session)) delete assignments[key];
    }
    if (!sessionTabs.value.length) {
      selectedSessionKeys[instanceId] = "overview";
      delete rightSelectedSessionKeys[instanceId];
      focusedSessionPanes[instanceId] = "left";
      sessionMenuOpen.value = false;
      return;
    }
    const leftTabs = orderedTabsForInstance(instanceId, sessionTabs.value).filter((session) => sessionPane(session) === "left");
    const rightTabs = orderedTabsForInstance(instanceId, sessionTabs.value).filter((session) => sessionPane(session) === "right");
    if (!leftTabs.some((session) => session.key === selectedSessionKeys[instanceId])) {
      const recentLeft = (recentSessionKeys[instanceId] || []).find((key) => leftTabs.some((session) => session.key === key));
      selectedSessionKeys[instanceId] = recentLeft || leftTabs.find((session) => session.kind === "ai")?.key || leftTabs[0]?.key || "overview";
    }
    if (!rightTabs.length) {
      delete rightSelectedSessionKeys[instanceId];
      focusedSessionPanes[instanceId] = "left";
    } else if (!rightTabs.some((session) => session.key === rightSelectedSessionKeys[instanceId])) {
      rightSelectedSessionKeys[instanceId] = rightTabs[0]!.key;
    }
  }

  function focusSessionPane(pane: SessionPaneId) {
    const instanceId = activeInstance.value?.id;
    if (!instanceId || (pane === "right" && !rightOrderedSessionTabs.value.length)) return;
    focusedSessionPanes[instanceId] = pane;
  }

  function rememberSessionKey(instanceId: string, sessionKey: string) {
    recentSessionKeys[instanceId] = [
      sessionKey,
      ...(recentSessionKeys[instanceId] || []).filter((key) => key !== sessionKey),
    ].slice(0, 12);
  }

  function setAppLaunchMenuOpen(open: boolean) {
    if (open) {
      if (!canLaunchApp.value || launchingApp.value) {
        appLaunchMenuOpen.value = false;
        return;
      }
      closeFloatingLayers("app");
    }
    appLaunchMenuOpen.value = open;
  }

  function setSessionMenuOpen(open: boolean) {
    if (open) {
      if (!sessionTabs.value.length) {
        sessionMenuOpen.value = false;
        return;
      }
      closeFloatingLayers("session");
    }
    sessionMenuOpen.value = open;
  }

  function selectSession(sessionKey: string, requestedPane?: SessionPaneId) {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) return;
    const nextSessionKey = activeInstance.value && hasInstanceStatusPage(activeInstance.value) ? "overview" : sessionKey;
    const session = sessionTabs.value.find((item) => item.key === nextSessionKey);
    if (!session) return;
    if (requestedPane && requestedPane !== sessionPane(session) && !isPinnedLeft(session)) moveSessionToPane(session.key, requestedPane);
    const pane = sessionPane(session);
    if (pane === "right") rightSelectedSessionKeys[instanceId] = nextSessionKey;
    else selectedSessionKeys[instanceId] = nextSessionKey;
    focusedSessionPanes[instanceId] = pane;
    rememberSessionKey(instanceId, nextSessionKey);
    sessionMenuOpen.value = false;
  }

  function moveSessionToPane(sessionKey: string, pane: SessionPaneId) {
    const instanceId = activeInstance.value?.id;
    const session = sessionTabs.value.find((item) => item.key === sessionKey);
    if (!instanceId || !session || isPinnedLeft(session)) return;
    const assignments = ensurePaneAssignments(instanceId);
    if (pane === "right") assignments[sessionKey] = true;
    else delete assignments[sessionKey];
    if (pane === "right") rightSelectedSessionKeys[instanceId] = sessionKey;
    else selectedSessionKeys[instanceId] = sessionKey;
    focusedSessionPanes[instanceId] = pane;
    rememberSessionKey(instanceId, sessionKey);
    normalizeSessionLayout();
  }

  function openSessionSplit() {
    const candidate = activeSession.value && !isPinnedLeft(activeSession.value) && sessionPane(activeSession.value) === "left"
      ? activeSession.value
      : [...leftOrderedSessionTabs.value].reverse().find((session) => !isPinnedLeft(session));
    if (candidate) moveSessionToPane(candidate.key, "right");
  }

  function closeSessionSplit() {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) return;
    const focusedKey = focusedSessionPanes[instanceId] === "right" ? rightSelectedSessionKeys[instanceId] : selectedSessionKeys[instanceId];
    for (const key of Object.keys(ensurePaneAssignments(instanceId))) delete rightPaneSessionKeys[instanceId]![key];
    if (focusedKey) selectedSessionKeys[instanceId] = focusedKey;
    delete rightSelectedSessionKeys[instanceId];
    focusedSessionPanes[instanceId] = "left";
    normalizeSessionLayout();
  }

  function setSessionSplitRatio(ratio: number) {
    const instanceId = activeInstance.value?.id;
    if (instanceId) sessionSplitRatios[instanceId] = Math.min(0.7, Math.max(0.3, ratio));
  }

  function orderedTabsForInstance(instanceId: string, tabs: SessionTab[]) {
    const byKey = new Map(tabs.map((session) => [session.key, session]));
    const order = sessionTabOrderKeys[instanceId] || [];
    return [
      ...order.map((key) => byKey.get(key)).filter((session): session is SessionTab => Boolean(session)),
      ...tabs.filter((session) => !order.includes(session.key)),
    ];
  }

  function pruneSessionTabOrder() {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) {
      return;
    }
    const availableKeys = new Set(sessionTabs.value.map((session) => session.key));
    const pruned = (sessionTabOrderKeys[instanceId] || []).filter((key) => availableKeys.has(key));
    if (pruned.length) {
      sessionTabOrderKeys[instanceId] = pruned;
    } else {
      delete sessionTabOrderKeys[instanceId];
    }
  }

  function moveSessionTab(sourceKey: string, targetKey: string, placement: "before" | "after", targetPane?: SessionPaneId) {
    const instanceId = activeInstance.value?.id;
    const sourceSession = sessionTabs.value.find((session) => session.key === sourceKey);
    if (!instanceId || !sourceSession || isPinnedLeft(sourceSession) || sourceKey === targetKey) {
      return;
    }
    const currentOrder = orderedTabsForInstance(instanceId, sessionTabs.value).map((session) => session.key);
    const sourceIndex = currentOrder.indexOf(sourceKey);
    if (sourceIndex < 0) {
      return;
    }
    if (targetPane) moveSessionToPane(sourceKey, targetPane);
    if (!targetKey) {
      const targetPaneKeys = currentOrder.filter((key) => {
        const session = sessionTabs.value.find((item) => item.key === key);
        return session && !isPinnedLeft(session) && sessionPane(session) === targetPane;
      });
      sessionTabOrderKeys[instanceId] = reorderSessionTabKeys(currentOrder, sourceKey, "", placement, targetPaneKeys);
      return;
    }
    sessionTabOrderKeys[instanceId] = reorderSessionTabKeys(currentOrder, sourceKey, targetKey, placement);
  }

  async function launchSelectedApp(instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>) {
    if (appId === REMOTE_DESKTOP_APP_ID) {
      openRemoteDesktopTab(instance.id);
      appLaunchMenuOpen.value = false;
      return;
    }
    if (appId === EMBEDDED_BROWSER_APP_ID) {
      openBrowserTab(instance.id);
      appLaunchMenuOpen.value = false;
      return;
    }
    if (!isInstanceAppReady(instance) || launchingApp.value) {
      return;
    }
    launchingApp.value = true;
    appLaunchMenuOpen.value = false;
    try {
      const session = await launchAppSession(instance.id, {
        appId,
        ...(cwdFolderId ? { cwdFolderId } : {}),
        ...(options ? { options } : {}),
      });
      const pane = focusedSessionPanes[instance.id] === "right" && rightSelectedSessionKeys[instance.id] ? "right" : "left";
      if (pane === "right") {
        ensurePaneAssignments(instance.id)[session.id] = true;
        rightSelectedSessionKeys[instance.id] = session.id;
      } else {
        selectedSessionKeys[instance.id] = session.id;
      }
      rememberSessionKey(instance.id, session.id);
      boardSessionKeys[instance.id] = session.id;
    } catch (error) {
      // 同一 Profile 只能有一个运行会话：实例返回 409 时直接聚焦已有会话。
      if (await focusRunningProfileSession(instance, error)) return;
      notifyError?.(errorText(error));
      await refresh();
    } finally {
      launchingApp.value = false;
    }
  }

  async function focusRunningProfileSession(instance: InstanceBoardItem, error: unknown) {
    if (!(error instanceof ApiError) || error.code !== "BROWSER_PROFILE_BUSY") return false;
    const sessionId = typeof error.details?.sessionId === "string" ? error.details.sessionId : "";
    if (!sessionId || !focusAppSession) return false;
    await focusAppSession(instance, sessionId);
    return true;
  }

  async function stopSelectedAppSession(instance: InstanceBoardItem, session: SessionTab) {
    if (session.kind === "ai" || session.kind === "status") {
      return;
    }
    if (session.kind === "remote-desktop") {
      // Closing a presentation keeps the last capture target, as on mobile.
      remoteDesktopSessionTabs[instance.id] = (remoteDesktopSessionTabs[instance.id] || []).filter((tab) => tab.key !== session.key);
      if (selectedSessionKeys[instance.id] === session.key) delete selectedSessionKeys[instance.id];
      if (rightSelectedSessionKeys[instance.id] === session.key) delete rightSelectedSessionKeys[instance.id];
      delete rightPaneSessionKeys[instance.id]?.[session.key];
      normalizeSessionLayout();
      return;
    }
    if (session.kind === "embedded-browser") {
      const pageKey = browserPageKeyOf(session);
      browserTabSlots[instance.id] = (browserTabSlots[instance.id] || []).filter((slot) => slot.key !== session.key);
      removeBrowserPageIfUnused(instance.id, pageKey);
      if (selectedSessionKeys[instance.id] === session.key) delete selectedSessionKeys[instance.id];
      if (rightSelectedSessionKeys[instance.id] === session.key) delete rightSelectedSessionKeys[instance.id];
      delete rightPaneSessionKeys[instance.id]?.[session.key];
      normalizeSessionLayout();
      return;
    }
    if (session.kind === "repository") {
      repositorySessionTabs[instance.id] = (repositorySessionTabs[instance.id] || []).filter((tab) => tab.key !== session.key);
      if (selectedSessionKeys[instance.id] === session.key) delete selectedSessionKeys[instance.id];
      if (rightSelectedSessionKeys[instance.id] === session.key) delete rightSelectedSessionKeys[instance.id];
      delete rightPaneSessionKeys[instance.id]?.[session.key];
      normalizeSessionLayout();
      return;
    }
    const sessionId = typeof session.source?.id === "string" ? session.source.id : session.key;
    if (stoppingSessionId.value || !sessionId) {
      return;
    }
    stoppingSessionId.value = session.key;
    sessionMenuOpen.value = false;
    try {
      await stopAppSession(instance.id, sessionId);
      if (selectedSessionKeys[instance.id] === session.key) delete selectedSessionKeys[instance.id];
      if (rightSelectedSessionKeys[instance.id] === session.key) delete rightSelectedSessionKeys[instance.id];
      delete rightPaneSessionKeys[instance.id]?.[session.key];
      normalizeSessionLayout();
      if (boardSessionKeys[instance.id] === session.key) {
        delete boardSessionKeys[instance.id];
      }
    } catch (error) {
      notifyError?.(errorText(error));
      await refresh();
    } finally {
      stoppingSessionId.value = "";
    }
  }

  function selectAiSession(instanceId: string, sessionId: string) {
    selectedAiSessionKeys[instanceId] = sessionId;
  }

  function selectedAiSessionSnapshotKey(instanceId: string, sessionId: string) {
    return JSON.stringify([instanceId, sessionId]);
  }

  function selectedAiSession(instance: InstanceBoardItem, sessions?: AiSessionSummary[]) {
    const available = sessions || [];
    const selectedId = selectedAiSessionKeys[instance.id];
    const selected = available.find((session) => session.id === selectedId);
    if (selected) {
      selectedAiSessionSnapshots[selectedAiSessionSnapshotKey(instance.id, selected.id)] = selected;
      return selected;
    }
    // Once a user has selected a session, do not silently replace it when a
    // completion patch temporarily omits it from the projection. This avoids
    // jumping to an unrelated session while the authoritative snapshot catches up.
    if (selectedId) return selectedAiSessionSnapshots[selectedAiSessionSnapshotKey(instance.id, selectedId)];
    return undefined;
  }

  function openAiSessionApp(instance: InstanceBoardItemWithAppSessions, session?: AiSessionSummary) {
    const tab = aiSessionAppTab(instance, session);
    if (tab) {
      selectAiSessionAppTab(instance.id, tab, session);
    } else if (session && (session.appSessionId || session.providerSessionId || session.appBindingKeys?.length)) {
      pendingAiSessionAppSelections.set(instance.id, session);
    }
  }

  function applyPendingAiSessionAppSelection() {
    const instance = activeInstance.value;
    if (!instance) return;
    const session = pendingAiSessionAppSelections.get(instance.id);
    if (!session) return;
    const tab = aiSessionAppTab(instance, session);
    if (!tab) return;
    pendingAiSessionAppSelections.delete(instance.id);
    selectAiSessionAppTab(instance.id, tab, session);
  }

  function selectAiSessionAppTab(instanceId: string, tab: SessionTab, session?: AiSessionSummary) {
    const alreadySelected = selectedSessionKeys[instanceId] === tab.key && focusedSessionPanes[instanceId] === "left";
    selectedSessionKeys[instanceId] = tab.key;
    focusedSessionPanes[instanceId] = "left";
    rememberSessionKey(instanceId, tab.key);
    if (session?.unread && !alreadySelected) void markAiSessionRead(instanceId, session.id).catch(() => undefined);
  }

  function openRepositoryWorkspace(target: RepositoryWorkspaceTabTarget) {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) return;
    const page = target.page === "changes-review" || target.page === "worktrees" ? target.page : "workspace";
    const key = page === "changes-review"
      ? `repository-changes:${target.sessionKind}:${target.sessionId}`
      : page === "worktrees"
        ? `repository-worktrees:${target.cwdFolderId || "instance-workspace"}`
        : `repository:${target.sessionKind}:${target.sessionId}`;
    const tabs = repositorySessionTabs[instanceId] ||= reactive<SessionTab[]>([]);
    const existingTab = tabs.find((tab) => tab.key === key);
    const source = target.filePath
      ? { ...target, page, fileRequestId: (Number(existingTab?.source?.fileRequestId) || 0) + 1 }
      : { ...target, page };
    if (!existingTab) {
      tabs.push({
        key,
        kind: "repository",
        label: page === "changes-review"
          ? t("repository.review.title")
          : page === "worktrees"
            ? t("repository.worktreesPanel.title")
            : t("repository.workspace.explorer"),
        status: "open",
        source,
      });
    } else {
      existingTab.source = source;
    }
    const pane = focusedSessionPanes[instanceId] === "right" && rightSelectedSessionKeys[instanceId] ? "right" : "left";
    if (pane === "right") {
      ensurePaneAssignments(instanceId)[key] = true;
      rightSelectedSessionKeys[instanceId] = key;
    } else {
      selectedSessionKeys[instanceId] = key;
    }
    focusedSessionPanes[instanceId] = pane;
    rememberSessionKey(instanceId, key);
    normalizeSessionLayout();
  }

  function openBrowserTab(instanceId: string, initialUrl?: string, options: { title?: string; creationRef?: string } = {}) {
    const page = createBrowserPage(instanceId, {
      title: options.title?.trim() || t("sessions.tabs.embeddedBrowser"),
      status: initialUrl ? "loading" : "running",
      initialUrl,
      currentUrl: initialUrl,
      creationRef: options.creationRef,
    });
    const key = `${BROWSER_TAB_SLOT_PREFIX}${createBrowserUuid()}`;
    const slots = browserTabSlots[instanceId] ||= reactive<BrowserTabSlot[]>([]);
    slots.push({ key, pageKey: page.key });
    const pane = focusedSessionPanes[instanceId] === "right" && rightSelectedSessionKeys[instanceId] ? "right" : "left";
    if (pane === "right") {
      ensurePaneAssignments(instanceId)[key] = true;
      rightSelectedSessionKeys[instanceId] = key;
    } else {
      selectedSessionKeys[instanceId] = key;
    }
    focusedSessionPanes[instanceId] = pane;
    rememberSessionKey(instanceId, key);
  }

  function browserPageKeyOf(session: SessionTab) {
    return typeof session.source?.pageKey === "string" ? session.source.pageKey : "";
  }

  function createBrowserPage(instanceId: string, input: { title: string; status: string; initialUrl?: string; currentUrl?: string; creationRef?: string }): BrowserPageRecord {
    const page: BrowserPageRecord = {
      key: `${BROWSER_PAGE_PREFIX}${createBrowserUuid()}`,
      title: input.title,
      status: input.status,
      ...(input.initialUrl ? { initialUrl: input.initialUrl } : {}),
      ...(input.currentUrl ? { currentUrl: input.currentUrl } : {}),
      ...(input.creationRef ? { creationRef: input.creationRef } : {}),
    };
    const pages = browserPages[instanceId] ||= reactive<BrowserPageRecord[]>([]);
    pages.push(page);
    return page;
  }

  function removeBrowserPageIfUnused(instanceId: string, pageKey: string) {
    if (!pageKey) return;
    if ((browserTabSlots[instanceId] || []).some((slot) => slot.pageKey === pageKey)) return;
    const pages = browserPages[instanceId];
    if (!pages) return;
    const index = pages.findIndex((page) => page.key === pageKey);
    if (index >= 0) pages.splice(index, 1);
  }

  /**
   * Moves a live page host into another tab slot without re-mounting its
   * <webview>. The destination's previous page is released and the source slot
   * receives a fresh blank page, matching "move, do not swap".
   */
  function moveBrowserPageToTab(instanceId: string, targetSlotKey: string, sourcePageKey: string) {
    const slots = browserTabSlots[instanceId];
    if (!slots) return false;
    const moved = moveBrowserPageToSlot(slots, targetSlotKey, sourcePageKey);
    if (!moved.ok) return false;
    removeBrowserPageIfUnused(instanceId, moved.replacedPageKey);
    const blankPage = createBrowserPage(instanceId, {
      title: t("sessions.tabs.embeddedBrowser"),
      status: "running",
    });
    moved.sourceSlot.pageKey = blankPage.key;
    return true;
  }

  function bindLocalBrowserSlotToPage(
    instanceId: string,
    slotKey: string,
    pageKey: string,
    input: { title?: string; status?: string; currentUrl?: string; initialUrl?: string; creationRef?: string } = {},
  ) {
    const slot = browserTabSlots[instanceId]?.find((candidate) => candidate.key === slotKey);
    if (!slot || !pageKey) return false;
    const previousPageKey = slot.pageKey;
    slot.pageKey = pageKey;
    if (!(browserPages[instanceId] || []).some((page) => page.key === pageKey)) {
      const pages = browserPages[instanceId] ||= reactive<BrowserPageRecord[]>([]);
      pages.push({
        key: pageKey,
        title: input.title?.trim() || t("sessions.tabs.embeddedBrowser"),
        status: input.status?.trim() || "running",
        ...(input.initialUrl ? { initialUrl: input.initialUrl } : {}),
        ...(input.currentUrl ? { currentUrl: input.currentUrl } : {}),
        ...(input.creationRef ? { creationRef: input.creationRef } : {}),
      });
    }
    if (previousPageKey !== pageKey) removeBrowserPageIfUnused(instanceId, previousPageKey);
    return true;
  }

  function blankLocalBrowserSlot(instanceId: string, slotKey: string) {
    const slot = browserTabSlots[instanceId]?.find((candidate) => candidate.key === slotKey);
    if (!slot) return false;
    const previousPageKey = slot.pageKey;
    const blankPage = createBrowserPage(instanceId, {
      title: t("sessions.tabs.embeddedBrowser"),
      status: "running",
    });
    slot.pageKey = blankPage.key;
    removeBrowserPageIfUnused(instanceId, previousPageKey);
    return true;
  }

  function openRemoteDesktopTab(instanceId: string, aiSessionId?: string) {
    if (!remoteDesktopEnabled.value || activeInstance.value?.id !== instanceId) return;
    const key = `${REMOTE_DESKTOP_APP_ID}:${instanceId}${aiSessionId ? `:${aiSessionId}` : ""}`;
    const tabs = remoteDesktopSessionTabs[instanceId] ||= reactive<SessionTab[]>([]);
    if (!tabs.some((tab) => tab.key === key)) {
      tabs.push({
        key,
        kind: "remote-desktop",
        label: REMOTE_DESKTOP_APP_ID,
        title: t("instances.remoteDesktop.title"),
        status: "running",
        ...(aiSessionId ? { source: { aiSessionId } } : {}),
      });
    }
    const pane = focusedSessionPanes[instanceId] === "right" && rightSelectedSessionKeys[instanceId] ? "right" : "left";
    if (pane === "right") {
      ensurePaneAssignments(instanceId)[key] = true;
      rightSelectedSessionKeys[instanceId] = key;
    } else {
      selectedSessionKeys[instanceId] = key;
    }
    focusedSessionPanes[instanceId] = pane;
    rememberSessionKey(instanceId, key);
    appLaunchMenuOpen.value = false;
  }

  function handleMarkdownBrowserRequest(event: Event) {
    const detail = (event as CustomEvent<{ instanceId?: string; url?: string }>).detail;
    if (!detail?.url || !detail.instanceId || detail.instanceId !== activeInstance.value?.id) return;
    try {
      const url = new URL(detail.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      openBrowserTab(detail.instanceId, url.toString());
    } catch {
      // Invalid URLs are rejected by the Markdown link classifier as well.
    }
  }

  function handleOpenRemoteDesktopRequest(event: Event) {
    const detail = (event as CustomEvent<OpenSessionRemoteDesktopDetail>).detail;
    if (!detail?.instanceId || !detail.sessionId) return;
    if (routeSessionRemoteDesktop?.(detail)) return;
    if (detail.instanceId !== activeInstance.value?.id) return;
    const current = sessionRemoteDesktopLinkFor(detail.instanceId, detail.sessionId);
    if (detail.target) {
      rememberSessionRemoteDesktopLink({ instanceId: detail.instanceId, sessionId: detail.sessionId, target: detail.target });
    } else if (current) {
      touchSessionRemoteDesktopLink(detail.instanceId, detail.sessionId);
    }
    openRemoteDesktopTab(detail.instanceId, detail.sessionId);
  }

  function handleCloseRemoteDesktopRequest(event: Event) {
    const detail = (event as CustomEvent<CloseSessionRemoteDesktopDetail>).detail;
    if (!detail?.instanceId || !detail.sessionId) return;
    removeSessionRemoteDesktopLink(detail.instanceId, detail.sessionId);
    const key = `${REMOTE_DESKTOP_APP_ID}:${detail.instanceId}:${detail.sessionId}`;
    remoteDesktopSessionTabs[detail.instanceId] = (remoteDesktopSessionTabs[detail.instanceId] || []).filter((tab) => tab.key !== key);
    if (selectedSessionKeys[detail.instanceId] === key) delete selectedSessionKeys[detail.instanceId];
    if (rightSelectedSessionKeys[detail.instanceId] === key) delete rightSelectedSessionKeys[detail.instanceId];
    delete rightPaneSessionKeys[detail.instanceId]?.[key];
    normalizeSessionLayout();
  }

  onMounted(() => {
    window.addEventListener("task-handoff:open-markdown-browser", handleMarkdownBrowserRequest);
    window.addEventListener(OPEN_SESSION_REMOTE_DESKTOP_EVENT, handleOpenRemoteDesktopRequest);
    window.addEventListener(CLOSE_SESSION_REMOTE_DESKTOP_EVENT, handleCloseRemoteDesktopRequest);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("task-handoff:open-markdown-browser", handleMarkdownBrowserRequest);
    window.removeEventListener(OPEN_SESSION_REMOTE_DESKTOP_EVENT, handleOpenRemoteDesktopRequest);
    window.removeEventListener(CLOSE_SESSION_REMOTE_DESKTOP_EVENT, handleCloseRemoteDesktopRequest);
  });

  function updateBrowserTab(instanceId: string, pageKey: string, patch: { title?: string; url?: string; status?: string }) {
    const page = browserPages[instanceId]?.find((candidate) => candidate.key === pageKey);
    if (!page) return;
    if (typeof patch.title === "string" && patch.title.trim()) page.title = patch.title.trim().slice(0, 120);
    if (typeof patch.url === "string" && patch.url.trim()) page.currentUrl = patch.url.trim().slice(0, 2000);
    if (typeof patch.status === "string" && patch.status.trim()) page.status = patch.status.trim();
  }

  function pruneBrowserInstances(validInstanceIds: ReadonlySet<string>) {
    const instanceIds = new Set([...Object.keys(browserTabSlots), ...Object.keys(browserPages)]);
    for (const instanceId of instanceIds) {
      if (validInstanceIds.has(instanceId)) continue;
      if (typeof window !== "undefined") {
        (window as Window & { taskHandoffDesktop?: { logBrowserDiagnostic?: (input: { message: string; instanceId?: string }) => void } }).taskHandoffDesktop?.logBrowserDiagnostic?.({
          message: `browser instances pruned tabs=${browserTabSlots[instanceId]?.length || 0}`,
          instanceId,
        });
      }
      delete browserTabSlots[instanceId];
      delete browserPages[instanceId];
      delete rightPaneSessionKeys[instanceId];
      delete rightSelectedSessionKeys[instanceId];
      delete selectedSessionKeys[instanceId];
      delete focusedSessionPanes[instanceId];
    }
    for (const instanceId of Object.keys(remoteDesktopSessionTabs)) {
      if (validInstanceIds.has(instanceId)) continue;
      delete remoteDesktopSessionTabs[instanceId];
      delete rightPaneSessionKeys[instanceId];
      delete rightSelectedSessionKeys[instanceId];
      delete selectedSessionKeys[instanceId];
      delete focusedSessionPanes[instanceId];
    }
  }

  watch(remoteDesktopSessionTabs, (tabs) => persistRemoteDesktopSessionTabs(tabs), { deep: true });

  return {
    activeAttachUrl,
    activeInstanceConnecting,
    activeInstanceWebUrl,
    activeOpenUrl,
    activeSession,
    activeSessionFrameUrl,
    activeSessionKey,
    activeTerminalSocketUrl,
    appLaunchButtonLabel,
    appLaunchButtonTitle,
    canLaunchApp,
    browserPages,
    browserSessionTabs,
    browserSurfaceState,
    remoteDesktopSessionTabs,
    launchableApps,
    launchingApp,
    launchSelectedApp,
    leftOrderedSessionTabs,
    leftSession,
    leftSessionKey,
    moveSessionTab,
    moveSessionToPane,
    moveBrowserPageToTab,
    bindLocalBrowserSlotToPage,
    blankLocalBrowserSlot,
    openAiSessionApp,
    openBrowserTab,
    pruneBrowserInstances,
    updateBrowserTab,
    openRepositoryWorkspace,
    openSessionSplit,
    orderedSessionTabs,
    focusSessionPane,
    focusedSessionPane,
    hasSessionSplit,
    rightOrderedSessionTabs,
    rightSession,
    rightSessionKey,
    selectAiSession,
    selectSession,
    selectedAiSession,
    sessionTabs,
    sessionSplitRatio,
    setSessionSplitRatio,
    closeSessionSplit,
    setAppLaunchMenuOpen,
    setSessionMenuOpen,
    stoppingSessionId,
    stopSelectedAppSession,
  };
}
