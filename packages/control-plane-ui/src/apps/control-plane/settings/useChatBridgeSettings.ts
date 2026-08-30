import { computed, ref, watch, type Ref } from "vue";
import { createChatBridge, deleteChatBridge, startChatBridge, stopChatBridge, updateChatBridge } from "../../../api/queries";
import type { ChatBridgeConfig, ChatChannel, ChatGatewayStatus } from "../../../api/types";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";
import { startSavedChatBridge } from "./chatBridgeToggle.ts";

type UseChatBridgeSettingsInput = {
  bridges: Ref<ChatBridgeConfig[] | undefined>;
  errorText: (error: unknown) => string;
  gatewayStatus: Ref<ChatGatewayStatus | undefined>;
  refresh: () => Promise<void>;
  translate: Translate;
};

const chatChannels: ChatChannel[] = ["telegram", "wechat", "dingding", "lark"];

export function useChatBridgeSettings({ bridges, errorText, gatewayStatus, refresh, translate: t }: UseChatBridgeSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const selectedChatBridgeId = ref("");
  const creatingChatBridge = ref(false);
  const savingChatBridge = ref(false);
  const togglingChatBridge = ref(false);
  const initialChatDraft = ref("");
  const chatAllowedUsersText = ref("");
  const chatForm = ref({
    name: "",
    token: "",
    defaultChatId: "",
    pollIntervalMs: "3000",
    settings: {
      baseUrl: "",
      contextToken: "",
      updatesBuf: "",
      clientSecret: "",
      appSecret: "",
      domain: "feishu",
      corpId: "",
      robotCode: "",
    },
  });

  const orderedChatBridges = computed(() => {
    return [...(bridges.value || [])].sort((a, b) => a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
  });
  const selectedChatBridge = computed(() => orderedChatBridges.value.find((bridge) => bridge.id === selectedChatBridgeId.value) || orderedChatBridges.value[0]);
  const selectedChatStatus = computed(() => selectedChatBridge.value ? gatewayStatus.value?.bridges.find((bridge) => bridge.id === selectedChatBridge.value?.id) : undefined);
  const chatBridgeBusy = computed(() => creatingChatBridge.value || savingChatBridge.value || togglingChatBridge.value);
  const chatDraftDirty = computed(() => serializeChatDraft() !== initialChatDraft.value);
  const chatTokenPlaceholder = computed(() => {
    if (selectedChatBridge.value?.channel === "dingding") return t("settings.chatBridge.clientIdPlaceholder");
    if (selectedChatBridge.value?.channel === "lark") return t("settings.chatBridge.appIdPlaceholder");
    return t("settings.chatBridge.botTokenPlaceholder");
  });

  watch(
    selectedChatBridge,
    (bridge) => {
      if (bridge && selectedChatBridgeId.value !== bridge.id) {
        selectedChatBridgeId.value = bridge.id;
      }
      syncChatForm(bridge);
    },
    { immediate: true },
  );

  function syncChatForm(bridge = selectedChatBridge.value) {
    const settings = bridge?.settings || {};
    chatForm.value = {
      name: String(bridge?.name || ""),
      token: "",
      defaultChatId: String(bridge?.defaultChatId || ""),
      pollIntervalMs: String(bridge?.pollIntervalMs || 3000),
      settings: {
        baseUrl: stringSetting(settings.baseUrl),
        contextToken: stringSetting(settings.contextToken),
        updatesBuf: stringSetting(settings.updatesBuf),
        clientSecret: "",
        appSecret: "",
        domain: stringSetting(settings.domain) || "feishu",
        corpId: stringSetting(settings.corpId),
        robotCode: stringSetting(settings.robotCode),
      },
    };
    chatAllowedUsersText.value = (bridge?.allowedUserIds || []).join("\n");
    initialChatDraft.value = serializeChatDraft();
  }

  function selectChatBridge(id: string) {
    selectedChatBridgeId.value = id;
  }

  async function createBridge(channel: ChatChannel) {
    if (creatingChatBridge.value) {
      return undefined;
    }
    creatingChatBridge.value = true;
    const loadingToast = showDelayedControlPlaneLoadingToast(t("settings.chatBridge.creating"));
    try {
      const bridge = await createChatBridge({ channel });
      selectedChatBridgeId.value = bridge.id;
      await refresh();
      showControlPlaneToast(t("settings.chatBridge.created", { name: bridge.name }), "success");
      return bridge;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return undefined;
    } finally {
      loadingToast.dismiss();
      creatingChatBridge.value = false;
    }
  }

  async function persistSelectedChatBridge(refreshAfterSave: boolean) {
    const bridge = selectedChatBridge.value;
    if (!bridge || savingChatBridge.value) {
      return false;
    }
    savingChatBridge.value = true;
    const loadingToast = showDelayedControlPlaneLoadingToast(t("settings.chatBridge.saving"));
    try {
      const settings: Record<string, unknown> = {};
      if (bridge.channel === "wechat") {
        settings.baseUrl = emptyToUndefined(chatForm.value.settings.baseUrl);
        settings.contextToken = emptyToUndefined(chatForm.value.settings.contextToken);
        settings.updatesBuf = emptyToUndefined(chatForm.value.settings.updatesBuf);
      }
      if (bridge.channel === "dingding") {
        settings.clientSecret = emptyToUndefined(chatForm.value.settings.clientSecret);
        settings.corpId = emptyToUndefined(chatForm.value.settings.corpId);
        settings.robotCode = emptyToUndefined(chatForm.value.settings.robotCode);
      }
      if (bridge.channel === "lark") {
        settings.appSecret = emptyToUndefined(chatForm.value.settings.appSecret);
        settings.domain = chatForm.value.settings.domain === "lark" ? "lark" : "feishu";
      }
      const updated = await updateChatBridge(bridge.id, {
        name: emptyToUndefined(chatForm.value.name),
        token: emptyToUndefined(chatForm.value.token),
        defaultChatId: emptyToUndefined(chatForm.value.defaultChatId),
        allowedUserIds: parseAllowedUsers(chatAllowedUsersText.value),
        pollIntervalMs: Math.max(1000, Number(chatForm.value.pollIntervalMs) || 3000),
        settings,
      });
      syncChatForm(updated);
      if (refreshAfterSave) await refresh();
      showControlPlaneToast(t("settings.chatBridge.saved", { name: updated.name }), "success");
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      loadingToast.dismiss();
      savingChatBridge.value = false;
    }
  }

  function saveSelectedChatBridge() {
    return persistSelectedChatBridge(true);
  }

  async function toggleChatBridge(bridge: ChatBridgeConfig, persistDraft = false) {
    if (!bridge || togglingChatBridge.value) {
      return false;
    }
    togglingChatBridge.value = true;
    const running = chatBridgeRunning(bridge.id);
    const loadingToast = showDelayedControlPlaneLoadingToast(running ? t("settings.chatBridge.stopping") : t("settings.chatBridge.starting"));
    try {
      if (running) {
        await stopChatBridge(bridge.id);
        await refresh();
        showControlPlaneToast(t("settings.chatBridge.stopped", { name: bridge.name }), "success");
      } else {
        const started = await startSavedChatBridge({
          persist: persistDraft ? () => persistSelectedChatBridge(false) : async () => true,
          start: () => startChatBridge(bridge.id),
          refresh,
        });
        if (!started) return false;
        showControlPlaneToast(t("settings.chatBridge.started", { name: bridge.name }), "success");
      }
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      loadingToast.dismiss();
      togglingChatBridge.value = false;
    }
  }

  function toggleSelectedChatBridge() {
    const bridge = selectedChatBridge.value;
    return bridge ? toggleChatBridge(bridge, true) : Promise.resolve(false);
  }

  async function removeChatBridge(bridge: ChatBridgeConfig) {
    if (!bridge || togglingChatBridge.value) {
      return false;
    }
    togglingChatBridge.value = true;
    const loadingToast = showDelayedControlPlaneLoadingToast(t("settings.chatBridge.deleting"));
    try {
      await deleteChatBridge(bridge.id);
      if (selectedChatBridgeId.value === bridge.id) selectedChatBridgeId.value = "";
      await refresh();
      showControlPlaneToast(t("settings.chatBridge.deleted", { name: bridge.name }), "success");
      return true;
    } catch (error) {
      showControlPlaneToast(translateError(error));
      return false;
    } finally {
      loadingToast.dismiss();
      togglingChatBridge.value = false;
    }
  }

  function chatChannelLabel(channel: ChatChannel) {
    if (channel === "telegram") {
      return "Telegram";
    }
    if (channel === "wechat") {
      return "WeChat";
    }
    if (channel === "dingding") {
      return "DingDing";
    }
    if (channel === "lark") {
      return "Feishu / Lark";
    }
    return channel;
  }

  function chatBridgeStatus(id: string) {
    return gatewayStatus.value?.bridges.find((bridge) => bridge.id === id);
  }

  function chatBridgeRunning(id: string) {
    return Boolean(chatBridgeStatus(id)?.running);
  }

  function chatBridgeRuntimeLine(id: string) {
    const status = chatBridgeStatus(id);
    const bridge = orderedChatBridges.value.find((item) => item.id === id);
    if (status?.error) {
      return status.error;
    }
    const credentialSet = bridge?.channel === "lark"
      ? Boolean((status?.tokenSet || bridge?.tokenSet) && bridge.settings.appSecretSet)
      : Boolean(status?.tokenSet || bridge?.tokenSet);
    return [
      credentialSet ? t("settings.chatBridge.credentialsSet") : t("settings.chatBridge.credentialsMissing"),
      bridge?.defaultChatId ? t("settings.chatBridge.chatId", { id: bridge.defaultChatId }) : t("settings.chatBridge.noDefaultChat"),
    ].join(" · ");
  }

  function chatBridgeDotClass(id: string) {
    const status = chatBridgeStatus(id);
    if (status?.error) {
      return "status-failed";
    }
    return chatBridgeRunning(id) ? "status-online" : "status-offline";
  }

  return {
    chatAllowedUsersText,
    chatBridgeBusy,
    chatBridgeStatus,
    chatBridgeDotClass,
    chatBridgeRunning,
    chatBridgeRuntimeLine,
    chatDraftDirty,
    chatChannelLabel,
    chatChannels,
    chatForm,
    chatTokenPlaceholder,
    createBridge,
    creatingChatBridge,
    orderedChatBridges,
    removeChatBridge,
    saveSelectedChatBridge,
    savingChatBridge,
    selectChatBridge,
    selectedChatBridge,
    selectedChatBridgeId,
    selectedChatStatus,
    toggleSelectedChatBridge,
    toggleChatBridge,
  };

  function serializeChatDraft() {
    return JSON.stringify({ form: chatForm.value, allowedUsers: chatAllowedUsersText.value });
  }
}

function parseAllowedUsers(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyToUndefined(value: string) {
  const text = value.trim();
  return text || undefined;
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}
