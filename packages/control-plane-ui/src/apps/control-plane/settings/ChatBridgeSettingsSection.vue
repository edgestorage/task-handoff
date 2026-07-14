<template>
  <div class="chat-settings-grid">
    <section class="modal-section">
      <div class="section-head">
        <span>Chat bridges · {{ orderedChatBridges.length }}</span>
        <Button variant="outline" size="sm" :disabled="isRefreshing" @click="refreshChat">
          <RefreshCw :size="14" />
          <span>{{ isRefreshing ? "Refreshing" : "Refresh" }}</span>
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
            <Badge :variant="chatBridgeRunning(bridge.id) ? 'default' : 'secondary'">{{ chatBridgeRunning(bridge.id) ? "Running" : bridge.enabled ? "Enabled" : "Off" }}</Badge>
          </button>
          <p v-if="!orderedChatBridges.length" class="settings-empty">No chat bridges configured.</p>
        </div>
      </ScrollArea>
      <p v-if="gatewayError" class="control-plane-error">{{ errorText(gatewayError) }}</p>
    </section>

    <section class="modal-section">
      <div v-if="selectedChatBridge" class="section-head">
        <span>{{ selectedChatBridge.name }} settings</span>
        <div class="settings-row-actions">
          <Badge :variant="chatBridgeRunning(selectedChatBridge.id) ? 'default' : 'secondary'">{{ chatBridgeRunning(selectedChatBridge.id) ? "Running" : "Stopped" }}</Badge>
          <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="toggleSelectedChatBridge">
            <Power :size="14" />
            <span>{{ chatBridgeRunning(selectedChatBridge.id) ? "Stop" : "Start" }}</span>
          </Button>
          <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="removeSelectedChatBridge">
            <Trash2 :size="14" />
            <span>Delete</span>
          </Button>
        </div>
      </div>
      <div v-if="selectedChatBridge" class="inline-create">
        <label>
          <span>Name</span>
          <ControlPlaneInput v-model="chatForm.name" placeholder="Bridge name" />
        </label>
        <label>
          <span>{{ selectedChatBridge.channel === 'dingding' ? 'Client ID' : 'Token' }}</span>
          <ControlPlaneInput v-model="chatForm.token" type="password" :placeholder="selectedChatBridge?.tokenSet ? 'Leave blank to keep current secret' : chatTokenPlaceholder" />
        </label>
        <div v-if="selectedChatBridge.channel === 'telegram'" class="settings-form-grid">
          <label>
            <span>Default chat ID</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" placeholder="123456789" />
          </label>
          <label>
            <span>Poll interval ms</span>
            <ControlPlaneInput v-model="chatForm.pollIntervalMs" type="number" placeholder="3000" />
          </label>
        </div>
        <div v-else-if="selectedChatBridge.channel === 'wechat'" class="settings-form-grid">
          <label>
            <span>Default chat ID</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" placeholder="wxid or room id" />
          </label>
          <label>
            <span>Context token</span>
            <ControlPlaneInput v-model="chatForm.settings.contextToken" type="password" placeholder="context token" />
          </label>
          <label>
            <span>Base URL</span>
            <ControlPlaneInput v-model="chatForm.settings.baseUrl" placeholder="https://ilinkai.weixin.qq.com" />
          </label>
          <label>
            <span>Updates cursor</span>
            <ControlPlaneInput v-model="chatForm.settings.updatesBuf" placeholder="saved automatically" />
          </label>
        </div>
        <div v-else-if="selectedChatBridge.channel === 'dingding'" class="settings-form-grid">
          <label>
            <span>Client secret</span>
            <ControlPlaneInput v-model="chatForm.settings.clientSecret" type="password" :placeholder="selectedChatBridge?.settings.clientSecretSet ? 'Leave blank to keep current secret' : 'client secret'" />
          </label>
          <label>
            <span>Robot code</span>
            <ControlPlaneInput v-model="chatForm.settings.robotCode" placeholder="robot code" />
          </label>
          <label>
            <span>Default conversation ID</span>
            <ControlPlaneInput v-model="chatForm.defaultChatId" placeholder="open conversation id" />
          </label>
          <label>
            <span>Corp ID</span>
            <ControlPlaneInput v-model="chatForm.settings.corpId" placeholder="optional" />
          </label>
        </div>
        <label>
          <span>Allowed user IDs</span>
          <ControlPlaneInput v-model="chatAllowedUsersText" placeholder="comma or newline separated" />
        </label>
        <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="saveSelectedChatBridge">
          <Settings :size="14" />
          <span>{{ savingChatBridge ? "Saving" : "Save bridge" }}</span>
        </Button>
      </div>
      <p v-else class="settings-empty">Create or select a chat bridge.</p>
      <p v-if="selectedChatStatus?.error" class="control-plane-error">{{ selectedChatStatus.error }}</p>
      <p v-if="chatBridgeSuccess" class="settings-success">{{ chatBridgeSuccess }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Plus, Power, RefreshCw, Settings, Trash2 } from "@lucide/vue";
import type { useChatBridgeSettings } from "./useChatBridgeSettings";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";

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

.modal-section {
  display: grid;
  gap: 12px;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow:
    var(--shadow-panel),
    inset 0 1px 0 var(--workspace-grid);
  padding: 12px;
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
