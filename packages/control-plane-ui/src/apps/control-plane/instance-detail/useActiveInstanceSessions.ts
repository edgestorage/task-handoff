import { computed, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import { launchAppSession, markAiSessionRead, stopAppSession } from "../../../api/queries";
import type { AiSessionSummary, InstanceBoardItem, InstanceBoardItemWithAppSessions, InstanceWithAiSessions } from "../../../api/types";
import {
  aiSessionAppTab,
  appDisplayName,
  absoluteInstanceUrl,
  buildSessionTabs,
  launchableAppsForInstance,
  selectedAiSession as resolveSelectedAiSession,
  sessionFrameUrl,
  sessionTerminalSocketUrl,
  uniqueLaunchableApps,
  type SessionTab,
  type RepositoryWorkspaceTabTarget,
} from "../useInstanceSessions";
import { hasInstanceStatusPage, isInstanceAppReady, isInstanceConnecting } from "../useInstanceStatus";
import { reorderSessionTabKeys } from "./sessionTabOrder";
import type { Translate } from "../../../i18n/status";

export type SessionPaneId = "left" | "right";

type UseActiveInstanceSessionsInput = {
  activeInstance: ComputedRef<InstanceWithAiSessions | undefined>;
  boardSessionKeys: Record<string, string>;
  closeFloatingLayers: (except?: "instance" | "session" | "app") => void;
  errorText: (error: unknown) => string;
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
  closeFloatingLayers,
  errorText,
  notifyError,
  refresh,
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
  const repositorySessionTabs = reactive<Record<string, SessionTab[]>>({});
  const pendingAiSessionAppSelections = new Map<string, AiSessionSummary>();

  const sessionTabs = computed(() => {
    const instanceId = activeInstance.value?.id;
    const instanceTabs = buildSessionTabs(activeInstance.value, t);
    return instanceTabs.some((session) => session.kind === "status")
      ? instanceTabs
      : [...instanceTabs, ...(instanceId ? repositorySessionTabs[instanceId] || [] : [])];
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
    const catalogApps = launchableAppsForInstance(activeInstance.value, t);
    if (catalogApps.length) {
      return catalogApps;
    }
    const ids = activeInstance.value.image?.optionalApps?.length ? activeInstance.value.image.optionalApps : ["terminal-tty"];
    return uniqueLaunchableApps(ids.map((id) => ({ id, label: appDisplayName(id, t) })));
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
      notifyError?.(errorText(error));
      await refresh();
    } finally {
      launchingApp.value = false;
    }
  }

  async function stopSelectedAppSession(instance: InstanceBoardItem, session: SessionTab) {
    if (session.kind === "ai" || session.kind === "status") {
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

  function selectedAiSession(instance: InstanceBoardItem, sessions?: AiSessionSummary[]) {
    return resolveSelectedAiSession(sessions, selectedAiSessionKeys[instance.id]);
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
    if (session?.unread && !alreadySelected) void markAiSessionRead(instanceId, session.id, session.updatedAt).catch(() => undefined);
  }

  function openRepositoryWorkspace(target: RepositoryWorkspaceTabTarget) {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) return;
    const page = target.page === "changes-review" || target.page === "worktrees" ? target.page : "workspace";
    const key = page === "changes-review"
      ? `repository-changes:${target.sessionKind}:${target.sessionId}`
      : page === "worktrees"
        ? `repository-worktrees:${target.sessionKind}:${target.sessionId}`
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
    launchableApps,
    launchingApp,
    launchSelectedApp,
    leftOrderedSessionTabs,
    leftSession,
    leftSessionKey,
    moveSessionTab,
    moveSessionToPane,
    openAiSessionApp,
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
