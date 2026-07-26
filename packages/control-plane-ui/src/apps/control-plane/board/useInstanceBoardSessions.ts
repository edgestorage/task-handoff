import type { ComputedRef, Ref } from "vue";
import type { InstanceBoardItem } from "../../../api/types";
import type { Translate } from "../../../i18n/status";
import type { SupportedLocale } from "../../../i18n/locale";
import { absoluteInstanceUrl, buildAppSessionTabs, previewDetail, previewTitle, sessionDisplayName, sessionFrameUrl, sessionMeta, sessionTerminalSocketUrl } from "../useInstanceSessions";

type UseInstanceBoardSessionsInput = {
  boardInteractive: Ref<boolean>;
  boardSessionKeys: Record<string, string>;
  boardVisibleInstances: ComputedRef<InstanceBoardItem[]>;
  t: Translate;
  locale: ComputedRef<string>;
};

export function useInstanceBoardSessions({ boardInteractive, boardSessionKeys, boardVisibleInstances, locale, t }: UseInstanceBoardSessionsInput) {
  function boardPrimarySession(instance: InstanceBoardItem) {
    const sessions = boardSessions(instance);
    const selectedKey = boardSessionKeys[instance.id];
    return sessions.find((session) => session.key === selectedKey) || sessions[0];
  }

  function boardSessions(instance: InstanceBoardItem) {
    return buildAppSessionTabs(instance, t);
  }

  function selectBoardSession(instanceId: string, sessionKey: string) {
    boardSessionKeys[instanceId] = sessionKey;
  }

  function applyBoardAppSelection(appId: string) {
    for (const instance of boardVisibleInstances.value) {
      const session = buildAppSessionTabs(instance, t).find((item) => item.label === appId);
      if (session) {
        boardSessionKeys[instance.id] = session.key;
      }
    }
  }

  function boardSessionFrameUrl(instance: InstanceBoardItem) {
    const session = boardPrimarySession(instance);
    return session ? sessionFrameUrl(instance, session, { compact: true, interactive: boardInteractive.value }) : "";
  }

  function boardTerminalSocketUrl(instance: InstanceBoardItem) {
    const session = boardPrimarySession(instance);
    return session ? sessionTerminalSocketUrl(instance, session) : "";
  }

  function boardOpenUrl(instance: InstanceBoardItem) {
    const webUrl = absoluteInstanceUrl(instance, "/");
    const session = boardPrimarySession(instance);
    if (!session) {
      return webUrl;
    }
    const frameUrl = sessionFrameUrl(instance, session);
    const terminalUrl = sessionTerminalSocketUrl(instance, session);
    return frameUrl || (!terminalUrl ? webUrl : webUrl);
  }

  function boardPreviewState(instance: InstanceBoardItem) {
    if (boardSessionFrameUrl(instance)) {
      return "live";
    }
    if (boardTerminalSocketUrl(instance)) {
      return "terminal";
    }
    return instance.connectionStatus;
  }

  function boardCardTitle(instance: InstanceBoardItem) {
    const session = boardPrimarySession(instance);
    if (session) {
      return sessionDisplayName(session, t);
    }
    return previewTitle(instance, t);
  }

  function boardCardDetail(instance: InstanceBoardItem) {
    const session = boardPrimarySession(instance);
    if (session) {
      return sessionMeta(session, t);
    }
    return previewDetail(instance, t, locale.value as SupportedLocale);
  }

  return {
    applyBoardAppSelection,
    boardCardDetail,
    boardCardTitle,
    boardOpenUrl,
    boardPreviewState,
    boardPrimarySession,
    boardSessionFrameUrl,
    boardSessions,
    boardTerminalSocketUrl,
    selectBoardSession,
  };
}
