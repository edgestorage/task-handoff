import { reactive, type ComputedRef, type Ref } from "vue";
import type { InstanceWithAiSessions } from "../../../api/types";
import type { Translate } from "../../../i18n/status";
import type { SupportedLocale } from "../../../i18n/locale";
import { buildAppSessionTabs, previewDetail, previewTitle, sessionDisplayName, sessionFrameUrl, sessionMeta, sessionTerminalSocketUrl, sortedAiSessions, type SessionTab } from "../useInstanceSessions";

export type BoardSessionTab = SessionTab;

type UseInstanceBoardSessionsInput = {
  boardInteractive: Ref<boolean>;
  boardSessionKeys: Record<string, string>;
  boardVisibleInstances: ComputedRef<InstanceWithAiSessions[]>;
  t: Translate;
  locale: ComputedRef<string>;
};

export function useInstanceBoardSessions({ boardInteractive, boardSessionKeys, boardVisibleInstances, locale, t }: UseInstanceBoardSessionsInput) {
  const boardAiSessionKeys = reactive<Record<string, string>>({});

  function boardPrimarySession(instance: InstanceWithAiSessions) {
    const sessions = boardSessions(instance);
    const selectedKey = boardSessionKeys[instance.id];
    return sessions.find((session) => session.key === selectedKey) || sessions[0];
  }

  function boardSessions(instance: InstanceWithAiSessions): BoardSessionTab[] {
    const appSessions = buildAppSessionTabs(instance, t);
    const aiSessions = sortedAiSessions(instance.aiSessions.sessions);
    const aiSessionTab: BoardSessionTab | undefined = aiSessions.length ? {
      aiSessions,
      key: "ai-sessions",
      kind: "ai",
      label: t("sessions.title"),
      status: aiSessions.some((session) => session.status === "waiting")
        ? "waiting"
        : aiSessions.some((session) => session.status === "running") ? "running" : "idle",
    } : undefined;
    return aiSessionTab ? [...appSessions, aiSessionTab] : appSessions;
  }

  function selectBoardSession(instanceId: string, sessionKey: string) {
    boardSessionKeys[instanceId] = sessionKey;
  }

  function boardAiSessions(instance: InstanceWithAiSessions) {
    return sortedAiSessions(instance.aiSessions.sessions);
  }

  function boardPrimaryAiSession(instance: InstanceWithAiSessions) {
    const sessions = boardAiSessions(instance);
    return sessions.find((session) => session.id === boardAiSessionKeys[instance.id]) || sessions[0];
  }

  function stepBoardAiSession(instance: InstanceWithAiSessions, direction: -1 | 1) {
    const sessions = boardAiSessions(instance);
    const currentIndex = Math.max(0, sessions.findIndex((session) => session.id === boardPrimaryAiSession(instance)?.id));
    const next = sessions[currentIndex + direction];
    if (next) boardAiSessionKeys[instance.id] = next.id;
  }

  function applyBoardAppSelection(appId: string) {
    for (const instance of boardVisibleInstances.value) {
      const session = buildAppSessionTabs(instance, t).find((item) => item.label === appId);
      if (session) {
        boardSessionKeys[instance.id] = session.key;
      }
    }
  }

  function boardSessionFrameUrl(instance: InstanceWithAiSessions) {
    const session = boardPrimarySession(instance);
    return session ? sessionFrameUrl(instance, session, { compact: true, interactive: boardInteractive.value }) : "";
  }

  function boardTerminalSocketUrl(instance: InstanceWithAiSessions) {
    const session = boardPrimarySession(instance);
    return session ? sessionTerminalSocketUrl(instance, session) : "";
  }

  function boardPreviewState(instance: InstanceWithAiSessions) {
    if (boardSessionFrameUrl(instance)) {
      return "live";
    }
    if (boardTerminalSocketUrl(instance)) {
      return "terminal";
    }
    return instance.connectionStatus;
  }

  function boardCardTitle(instance: InstanceWithAiSessions) {
    const session = boardPrimarySession(instance);
    if (session) {
      return sessionDisplayName(session, t);
    }
    return previewTitle(instance, t);
  }

  function boardCardDetail(instance: InstanceWithAiSessions) {
    const session = boardPrimarySession(instance);
    if (session) {
      return sessionMeta(session, t);
    }
    return previewDetail(instance, t, locale.value as SupportedLocale);
  }

  return {
    applyBoardAppSelection,
    boardAiSessions,
    boardCardDetail,
    boardCardTitle,
    boardPreviewState,
    boardPrimarySession,
    boardPrimaryAiSession,
    boardSessionFrameUrl,
    boardSessions,
    boardTerminalSocketUrl,
    selectBoardSession,
    stepBoardAiSession,
  };
}
