<template>
  <div class="chat-settings-grid">
    <section class="modal-section settings-panel-surface">
      <div class="section-head">
        <span>{{ t("settings.chatBridge.count", { count: orderedChatBridges.length }) }}</span>
        <Button variant="outline" size="sm" :disabled="isRefreshing" @click="refreshChat">
          <RefreshCw :size="14" />
          <span>{{ isRefreshing ? t("common.actions.refreshing") : t("common.actions.refresh") }}</span>
        </Button>
      </div>
      <div class="settings-row-actions chat-create-actions">
        <Button v-for="channel in chatChannels" :key="channel" variant="outline" size="sm" :disabled="creatingChatBridge || chatBridgeBusy" @click="createBridge(channel)">
          <Plus :size="14" />
          <span>{{ chatChannelLabel(channel) }}</span>
        </Button>
      </div>
      <ScrollArea class="chat-bridge-list">
        <div class="settings-scroll-content">
          <button v-for="bridge in orderedChatBridges" :key="bridge.id" type="button" class="chat-bridge-row" :class="{ active: selectedChatBridgeId === bridge.id }" @click="selectChatBridge(bridge.id)">
            <span class="node-status-dot" :class="chatBridgeDotClass(bridge.id)" />
            <span>
              <strong>{{ bridge.name }}</strong>
              <small>{{ chatChannelLabel(bridge.channel) }} · {{ chatBridgeRuntimeLine(bridge.id) }}</small>
            </span>
            <Badge :variant="chatBridgeRunning(bridge.id) ? 'default' : 'secondary'">{{ chatBridgeRunning(bridge.id) ? t("common.status.running") : bridge.enabled ? t("common.status.enabled") : t("common.status.off") }}</Badge>
          </button>
          <p v-if="!orderedChatBridges.length" class="settings-empty">{{ t("settings.chatBridge.empty") }}</p>
        </div>
      </ScrollArea>
      <p v-if="gatewayError" class="control-plane-error">{{ errorText(gatewayError) }}</p>
    </section>

    <section class="modal-section settings-panel-surface">
      <div v-if="selectedChatBridge" class="section-head">
        <span>{{ t("settings.chatBridge.settings", { name: selectedChatBridge.name }) }}</span>
        <div class="settings-row-actions">
          <Badge :variant="chatBridgeRunning(selectedChatBridge.id) ? 'default' : 'secondary'">{{ chatBridgeRunning(selectedChatBridge.id) ? t("common.status.running") : t("common.status.stopped") }}</Badge>
          <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="toggleSelectedChatBridge">
            <Power :size="14" />
            <span>{{ chatBridgeRunning(selectedChatBridge.id) ? t("instances.actions.stop") : t("instances.actions.start") }}</span>
          </Button>
          <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="removeSelectedChatBridge">
            <Trash2 :size="14" />
            <span>{{ t("common.actions.delete") }}</span>
          </Button>
        </div>
      </div>
      <div v-if="selectedChatBridge" class="inline-create">
        <label>
          <span>{{ t("settings.chatBridge.name") }}</span>
          <ControlPlaneInput v-model="chatForm.name" :placeholder="t('settings.chatBridge.bridgeName')" />
        </label>
        <label>
          <span>{{ selectedChatBridge.channel === 'dingding' ? t('settings.chatBridge.clientId') : selectedChatBridge.channel === 'lark' ? t('settings.chatBridge.appId') : t('settings.chatBridge.token') }}</span>
          <ControlPlaneInput v-model="chatForm.token" :type="selectedChatBridge.channel === 'lark' ? 'text' : 'password'" :placeholder="selectedChatBridge?.tokenSet ? t('settings.chatBridge.keepSecret') : chatTokenPlaceholder" />
        </label>
        <div v-if="selectedChatBridge.channel === 'telegram'" class="settings-form-grid">
          <label>
            <span>{{ t("settings.chatBridge.defaultChatId") }}</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" placeholder="123456789" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.pollInterval") }}</span>
            <ControlPlaneInput v-model="chatForm.pollIntervalMs" type="number" placeholder="3000" />
          </label>
        </div>
        <div v-else-if="selectedChatBridge.channel === 'wechat'" class="settings-form-grid">
          <label>
            <span>{{ t("settings.chatBridge.defaultChatId") }}</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" :placeholder="t('settings.chatBridge.wechatIdPlaceholder')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.contextToken") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.contextToken" type="password" :placeholder="t('settings.chatBridge.contextTokenPlaceholder')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.baseUrl") }}</span>
            <!-- i18n-audit-allow-next-line code-token: WeChat API endpoint example -->
            <ControlPlaneInput v-model="chatForm.settings.baseUrl" placeholder="https://ilinkai.weixin.qq.com" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.updatesCursor") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.updatesBuf" :placeholder="t('settings.chatBridge.savedAutomatically')" />
          </label>
        </div>
        <div v-else-if="selectedChatBridge.channel === 'dingding'" class="settings-form-grid">
          <label>
            <span>{{ t("settings.chatBridge.clientSecret") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.clientSecret" type="password" :placeholder="selectedChatBridge?.settings.clientSecretSet ? t('settings.chatBridge.keepSecret') : t('settings.chatBridge.clientSecret')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.robotCode") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.robotCode" :placeholder="t('settings.chatBridge.robotCodePlaceholder')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.conversationId") }}</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" :placeholder="t('settings.chatBridge.conversationIdPlaceholder')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.corpId") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.corpId" :placeholder="t('settings.chatBridge.optional')" />
          </label>
        </div>
        <div v-else-if="selectedChatBridge.channel === 'lark'" class="settings-form-grid">
          <label>
            <span>{{ t("settings.chatBridge.appSecret") }}</span>
            <ControlPlaneInput v-model="chatForm.settings.appSecret" type="password" :placeholder="selectedChatBridge?.settings.appSecretSet ? t('settings.chatBridge.keepSecret') : t('settings.chatBridge.appSecret')" />
          </label>
          <label>
            <span>{{ t("settings.chatBridge.domain") }}</span>
            <ControlPlaneSelect v-model="chatForm.settings.domain">
              <ControlPlaneSelectItem value="feishu">{{ t("settings.chatBridge.feishuChina") }}</ControlPlaneSelectItem>
              <ControlPlaneSelectItem value="lark">{{ t("settings.chatBridge.larkGlobal") }}</ControlPlaneSelectItem>
            </ControlPlaneSelect>
          </label>
          <label>
            <span>{{ t("settings.chatBridge.defaultChatId") }}</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" :placeholder="t('settings.chatBridge.larkChatIdPlaceholder')" />
          </label>
        </div>
        <label>
          <span>{{ t("settings.chatBridge.allowedUsers") }}</span>
          <ControlPlaneInput v-model="chatAllowedUsersText" :placeholder="selectedChatBridge.channel === 'lark' ? t('settings.chatBridge.larkAllowedUsersPlaceholder') : t('settings.chatBridge.allowedUsersPlaceholder')" />
        </label>
        <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="saveSelectedChatBridge">
          <Settings :size="14" />
          <span>{{ t("settings.chatBridge.save") }}</span>
        </Button>
      </div>
      <p v-else class="settings-empty">{{ t("settings.chatBridge.createOrSelect") }}</p>
      <p v-if="selectedChatStatus?.error" class="control-plane-error">{{ selectedChatStatus.error }}</p>
      <p v-if="chatBridgeSuccess" class="settings-success">{{ chatBridgeSuccess }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Plus, Power, RefreshCw, Settings, Trash2 } from "@lucide/vue";
import type { useChatBridgeSettings } from "./useChatBridgeSettings";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const { t } = useI18n();

const props = defineProps<{
  chat: ReturnType<typeof useChatBridgeSettings>;
  errorText: (error: unknown) => string;
  gatewayError: unknown;
  isRefreshing: boolean;
  refreshChat: () => Promise<void>;
}>();

const {
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
} = props.chat;
</script>

<style scoped>
.chat-settings-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.82fr) minmax(0, 1.18fr);
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.chat-bridge-list {
  min-height: 0;
  max-height: min(520px, calc(100vh - 270px));
  padding-right: 2px;
}

.settings-scroll-content {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 100%;
  padding-right: 2px;
}

.chat-bridge-row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: inherit;
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.chat-bridge-row:hover,
.chat-bridge-row:focus-visible,
.chat-bridge-row.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.chat-bridge-row > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.chat-bridge-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-bridge-row small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  margin-top: 4px;
  box-shadow: 0 0 0 3px var(--surface-subtle);
}

.node-status-dot.status-online {
  background: var(--status-success);
  box-shadow: 0 0 0 3px var(--brand-accent-soft);
}

.node-status-dot.status-offline,
.node-status-dot.status-failed {
  background: var(--status-danger);
  box-shadow: 0 0 0 3px var(--status-danger-bg);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head span,
.modal-section label span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head .inline-flex {
  flex: 0 0 auto;
}

.settings-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
}

.checkbox-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.checkbox-row label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px 0 34px;
}

.checkbox-row input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  margin: 0;
}

.checkbox-row label::before {
  position: absolute;
  left: 11px;
  top: 50%;
  display: grid;
  width: 15px;
  height: 15px;
  place-items: center;
  border: 1px solid var(--text-subtle);
  border-radius: 4px;
  background: var(--surface-inset);
  color: transparent;
  content: "";
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  transform: translateY(-50%);
}

.checkbox-row label:hover,
.checkbox-row label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.checkbox-row label:has(input:focus-visible) {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.checkbox-row label:has(input:checked) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.checkbox-row label:has(input:checked)::before {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
  color: var(--surface-inset);
  content: "✓";
}

.settings-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.modal-section label,
.inline-create {
  display: grid;
  gap: 7px;
}

.inline-create {
  gap: 9px;
}

.settings-empty,
.settings-success,
.control-plane-error {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}

.settings-empty {
  color: var(--text-muted);
}

.settings-success {
  color: var(--status-success);
}

.control-plane-error {
  color: var(--status-danger);
}

@media (max-width: 780px) {
  .chat-settings-grid,
  .settings-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
