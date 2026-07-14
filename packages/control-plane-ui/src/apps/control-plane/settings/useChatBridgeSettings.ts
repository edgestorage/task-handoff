import { computed, ref, watch, type Ref } from "vue";
import { createChatBridge, deleteChatBridge, startChatBridge, stopChatBridge, updateChatBridge } from "../../../api/queries";
import type { ChatBridgeConfig, ChatChannel, ChatGatewayStatus } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type UseChatBridgeSettingsInput = {
  bridges: Ref<ChatBridgeConfig[] | undefined>;
  errorText: (error: unknown) => string;
  gatewayStatus: Ref<ChatGatewayStatus | undefined>;
  refresh: () => Promise<void>;
};

const chatChannels: ChatChannel[] = ["telegram", "wechat", "dingding"];

export function useChatBridgeSettings({ bridges, errorText, gatewayStatus, refresh }: UseChatBridgeSettingsInput) {
  const selectedChatBridgeId = ref("");
  const creatingChatBridge = ref(false);
  const savingChatBridge = ref(false);
  const togglingChatBridge = ref(false);
  const chatBridgeSuccess = ref("");
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
  const chatTokenPlaceholder = computed(() => selectedChatBridge.value?.channel === "wechat" ? "bot token" : selectedChatBridge.value?.channel === "dingding" ? "client id" : "bot token");

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
        corpId: stringSetting(settings.corpId),
        robotCode: stringSetting(settings.robotCode),
      },
    };
    chatAllowedUsersText.value = (bridge?.allowedUserIds || []).join("\n");
  }

  function clearChatFeedback() {
    chatBridgeSuccess.value = "";
  }

  function selectChatBridge(id: string) {
    selectedChatBridgeId.value = id;
    clearChatFeedback();
  }

  async function createBridge(channel: ChatChannel) {
    if (creatingChatBridge.value) {
      return;
    }
    creatingChatBridge.value = true;
    clearChatFeedback();
    try {
      const bridge = await createChatBridge({ channel });
      selectedChatBridgeId.value = bridge.id;
      chatBridgeSuccess.value = `${bridge.name} bridge created.`;
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      creatingChatBridge.value = false;
    }
  }

  async function saveSelectedChatBridge() {
    const bridge = selectedChatBridge.value;
    if (!bridge || savingChatBridge.value) {
      return false;
    }
    savingChatBridge.value = true;
    clearChatFeedback();
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
      await updateChatBridge(bridge.id, {
        name: emptyToUndefined(chatForm.value.name),
        token: emptyToUndefined(chatForm.value.token),
        defaultChatId: emptyToUndefined(chatForm.value.defaultChatId),
        allowedUserIds: parseAllowedUsers(chatAllowedUsersText.value),
        pollIntervalMs: Math.max(1000, Number(chatForm.value.pollIntervalMs) || 3000),
        settings,
      });
      chatBridgeSuccess.value = `${chatForm.value.name || bridge.name} bridge saved.`;
      await refresh();
      syncChatForm();
      return true;
    } catch (error) {
      showControlPlaneToast(errorText(error));
      return false;
    } finally {
      savingChatBridge.value = false;
    }
  }

  async function toggleSelectedChatBridge() {
    const bridge = selectedChatBridge.value;
    if (!bridge || togglingChatBridge.value) {
      return;
    }
    togglingChatBridge.value = true;
    clearChatFeedback();
    try {
      if (chatBridgeRunning(bridge.id)) {
        await stopChatBridge(bridge.id);
        chatBridgeSuccess.value = `${bridge.name} bridge stopped.`;
      } else {
        const saved = await saveSelectedChatBridge();
        if (!saved) {
          return;
        }
        await startChatBridge(bridge.id);
        chatBridgeSuccess.value = `${bridge.name} bridge started.`;
      }
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      togglingChatBridge.value = false;
    }
  }

  async function removeSelectedChatBridge() {
    const bridge = selectedChatBridge.value;
    if (!bridge || togglingChatBridge.value) {
      return;
    }
    togglingChatBridge.value = true;
    clearChatFeedback();
    try {
      await deleteChatBridge(bridge.id);
      selectedChatBridgeId.value = "";
      chatBridgeSuccess.value = `${bridge.name} bridge deleted.`;
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
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
    return [
      status?.tokenSet || bridge?.tokenSet ? "secret set" : "secret missing",
      bridge?.defaultChatId ? `chat ${bridge.defaultChatId}` : "no default chat",
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
    chatBridgeDotClass,
    chatBridgeRunning,
    chatBridgeRuntimeLine,
    chatBridgeSuccess,
    chatChannelLabel,
    chatChannels,
    chatForm,
    chatTokenPlaceholder,
    clearChatFeedback,
    createBridge,
    creatingChatBridge,
    orderedChatBridges,
    removeSelectedChatBridge,
    saveSelectedChatBridge,
    savingChatBridge,
    selectChatBridge,
    selectedChatBridge,
    selectedChatBridgeId,
    selectedChatStatus,
    toggleSelectedChatBridge,
  };
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
