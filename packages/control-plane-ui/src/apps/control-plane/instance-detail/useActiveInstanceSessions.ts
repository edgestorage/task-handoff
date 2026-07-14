import { computed, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import { launchAppSession, stopAppSession } from "../../../api/queries";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
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
} from "../useInstanceSessions";
import { isInstanceAppReady, isInstanceConnecting } from "../useInstanceStatus";

type UseActiveInstanceSessionsInput = {
  activeInstance: ComputedRef<InstanceWithAiSessions | undefined>;
  boardSessionKeys: Record<string, string>;
  closeFloatingLayers: (except?: "instance" | "session" | "app") => void;
  errorText: (error: unknown) => string;
  notifyError?: (message: string) => void;
  refresh: () => Promise<void>;
  appLaunchMenuOpen: Ref<boolean>;
  sessionMenuOpen: Ref<boolean>;
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
}: UseActiveInstanceSessionsInput) {
  const launchingApp = ref(false);
  const stoppingSessionId = ref("");
  const selectedSessionKeys = reactive<Record<string, string>>({});
  const recentSessionKeys = reactive<Record<string, string[]>>({});
  const sessionTabOrderKeys = reactive<Record<string, string[]>>({});
  const selectedAiSessionKeys = reactive<Record<string, string>>({});

  const sessionTabs = computed(() => buildSessionTabs(activeInstance.value));
  const orderedSessionTabs = computed(() => {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) {
      return sessionTabs.value;
    }
    return orderedTabsForInstance(instanceId, sessionTabs.value);
  });
  const activeSessionKey = computed({
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
      return "Launching";
    }
    if (activeInstanceConnecting.value) {
      return "Connecting";
    }
    if (activeInstance.value && activeInstance.value.connectionStatus !== "online") {
      return "Offline";
    }
    return "App";
  });
  const appLaunchButtonTitle = computed(() =>
    activeInstance.value && !isInstanceAppReady(activeInstance.value)
      ? "Instance is still starting. Apps can be launched after it connects."
      : "Launch app",
  );
  const launchableApps = computed(() => {
    if (!activeInstance.value) {
      return [];
    }
    const catalogApps = launchableAppsForInstance(activeInstance.value);
    if (catalogApps.length) {
      return catalogApps;
    }
    const ids = activeInstance.value.image?.optionalApps?.length ? activeInstance.value.image.optionalApps : ["terminal-tty"];
    return uniqueLaunchableApps(ids.map((id) => ({ id, label: appDisplayName(id) })));
  });

  watch(
    () => activeInstance.value?.id,
    () => {
      ensureActiveSessionKey();
    },
  );

  watch(
    () => sessionTabs.value.map((session) => session.key).join("\n"),
    () => {
      if (!sessionTabs.value.length) {
        activeSessionKey.value = "overview";
        sessionMenuOpen.value = false;
        pruneSessionTabOrder();
        return;
      }
      pruneSessionTabOrder();
      if (!sessionTabs.value.some((session) => session.key === activeSessionKey.value)) {
        ensureActiveSessionKey();
      }
    },
  );

  function ensureActiveSessionKey() {
    const instanceId = activeInstance.value?.id;
    if (!instanceId) {
      return;
    }
    if (!sessionTabs.value.length) {
      selectedSessionKeys[instanceId] = "overview";
      sessionMenuOpen.value = false;
      return;
    }
    if (!sessionTabs.value.some((session) => session.key === selectedSessionKeys[instanceId])) {
      selectedSessionKeys[instanceId] = fallbackSessionKey(instanceId);
    }
  }

  function fallbackSessionKey(instanceId: string) {
    const availableKeys = new Set(sessionTabs.value.map((session) => session.key));
    const recentKey = (recentSessionKeys[instanceId] || []).find((key) => availableKeys.has(key));
    return recentKey || sessionTabs.value.find((session) => session.kind !== "ai")?.key || sessionTabs.value[0]?.key || "overview";
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

  function selectSession(sessionKey: string) {
    const instanceId = activeInstance.value?.id;
    if (instanceId) {
      selectedSessionKeys[instanceId] = sessionKey;
      rememberSessionKey(instanceId, sessionKey);
    }
    sessionMenuOpen.value = false;
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

  function moveSessionTab(sourceKey: string, targetKey: string, placement: "before" | "after") {
    const instanceId = activeInstance.value?.id;
    if (!instanceId || sourceKey === targetKey) {
      return;
    }
    const currentOrder = orderedTabsForInstance(instanceId, sessionTabs.value).map((session) => session.key);
    const sourceIndex = currentOrder.indexOf(sourceKey);
    const targetIndex = currentOrder.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    const nextOrder = currentOrder.filter((key) => key !== sourceKey);
    const targetIndexAfterRemoval = nextOrder.indexOf(targetKey);
    if (targetIndexAfterRemoval < 0) {
      return;
    }
    nextOrder.splice(placement === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, sourceKey);
    sessionTabOrderKeys[instanceId] = nextOrder;
  }

  async function launchSelectedApp(instance: InstanceBoardItem, appId: string, cwdFolderId?: string) {
    if (!isInstanceAppReady(instance) || launchingApp.value) {
      return;
    }
    launchingApp.value = true;
    appLaunchMenuOpen.value = false;
    try {
      const session = await launchAppSession(instance.id, { appId, ...(cwdFolderId ? { cwdFolderId } : {}) });
      selectedSessionKeys[instance.id] = session.id;
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
    if (session.kind === "ai") {
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
      if (activeSessionKey.value === session.key) {
        delete selectedSessionKeys[instance.id];
        ensureActiveSessionKey();
      }
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

  function openAiSessionApp(instance: InstanceBoardItem, session?: AiSessionSummary) {
    const tab = aiSessionAppTab(instance, session);
    if (tab) {
      selectedSessionKeys[instance.id] = tab.key;
      rememberSessionKey(instance.id, tab.key);
    }
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
    moveSessionTab,
    openAiSessionApp,
    orderedSessionTabs,
    selectAiSession,
    selectSession,
    selectedAiSession,
    sessionTabs,
    setAppLaunchMenuOpen,
    setSessionMenuOpen,
    stoppingSessionId,
    stopSelectedAppSession,
  };
}
