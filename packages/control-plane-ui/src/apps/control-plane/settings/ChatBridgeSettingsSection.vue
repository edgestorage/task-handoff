<template>
  <ScrollArea class="chat-settings-scroll" :horizontal="false">
    <div class="chat-settings-page">
      <header class="chat-page-head">
        <p>{{ t("settings.chatBridge.pageDescription") }}</p>
        <div class="chat-head-actions">
          <Button variant="outline" size="sm" :disabled="isRefreshing" @click="refreshChat">
            <RefreshCw :size="14" :class="{ spin: isRefreshing }" />
            <span>{{ isRefreshing ? t("common.actions.refreshing") : t("common.actions.refresh") }}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button size="sm" :disabled="creatingChatBridge">
                <Plus :size="14" />
                <span>{{ t("settings.chatBridge.add") }}</span>
                <ChevronDown :size="13" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" :side-offset="6">
              <DropdownMenuLabel>{{ t("settings.chatBridge.chooseChannel") }}</DropdownMenuLabel>
              <DropdownMenuItem v-for="channel in chatChannels" :key="channel" @select="createAndEdit(channel)">
                <MessageCircle :size="14" />
                <span>{{ chatChannelLabel(channel) }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div class="chat-toolbar">
        <div class="chat-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="searchQuery" :aria-label="t('settings.chatBridge.search')" :placeholder="t('settings.chatBridge.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="channelFilter" :aria-label="t('settings.chatBridge.channelFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.chatBridge.allChannels") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="channel in chatChannels" :key="channel" :value="channel">{{ chatChannelLabel(channel) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="statusFilter" :aria-label="t('settings.chatBridge.statusFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.chatBridge.allStatuses") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="running">{{ t("common.status.running") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="stopped">{{ t("common.status.stopped") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="error">{{ t("settings.chatBridge.statusError") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section v-if="gatewayError" class="chat-diagnostics" role="alert">
        <AlertTriangle :size="16" aria-hidden="true" />
        <div><strong>{{ t("settings.chatBridge.gatewayUnavailable") }}</strong><span>{{ errorText(gatewayError) }}</span></div>
        <Button variant="ghost" size="sm" :disabled="isRefreshing" @click="refreshChat"><RefreshCw :size="14" /><span>{{ t("common.actions.retry") }}</span></Button>
      </section>

      <section class="chat-directory" :aria-label="t('settings.chatBridge.count', { count: filteredBridges.length })">
        <header class="chat-directory-head">
          <strong>{{ t("settings.chatBridge.count", { count: filteredBridges.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.chatBridge.filteredFrom", { count: orderedChatBridges.length }) }}</span>
        </header>

        <div v-if="!filteredBridges.length" class="chat-empty-state">
          <MessageCircleMore :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.chatBridge.noMatches") : t("settings.chatBridge.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.chatBridge.noMatchesDescription") : t("settings.chatBridge.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.chatBridge.clearFilters") }}</Button>
        </div>

        <div v-else class="chat-list">
          <article v-for="bridge in filteredBridges" :key="bridge.id" class="chat-row" data-chat-bridge-row>
            <div class="chat-row-main">
              <div class="chat-identity">
                <span class="chat-status-dot" :class="chatBridgeDotClass(bridge.id)" />
                <div>
                  <div class="chat-title-line"><strong>{{ bridge.name }}</strong><Badge variant="secondary">{{ chatChannelLabel(bridge.channel) }}</Badge></div>
                  <span :class="{ 'chat-runtime-error': chatBridgeStatus(bridge.id)?.error }">{{ chatBridgeRuntimeLine(bridge.id) }}</span>
                </div>
              </div>
              <div class="chat-summary">
                <span><Users :size="14" />{{ t("settings.chatBridge.allowedUsersCount", { count: bridge.allowedUserIds.length }) }}</span>
                <span><Clock3 :size="14" />{{ t("settings.chatBridge.pollEvery", { value: bridge.pollIntervalMs }) }}</span>
              </div>
              <div class="chat-row-status">
                <Badge :variant="chatBridgeRunning(bridge.id) ? 'default' : 'secondary'">{{ bridgeStatusLabel(bridge) }}</Badge>
              </div>
              <div class="chat-row-actions">
                <Button variant="outline" size="sm" :disabled="chatBridgeBusy" @click="openEditor(bridge)"><Settings :size="14" /><span>{{ t("settings.chatBridge.configure") }}</span></Button>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :disabled="chatBridgeBusy" :aria-label="t('settings.chatBridge.moreActions')"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" :side-offset="6">
                    <DropdownMenuItem @select="toggleChatBridge(bridge)"><Power :size="14" /><span>{{ chatBridgeRunning(bridge.id) ? t("instances.actions.stop") : t("instances.actions.start") }}</span></DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-destructive focus:text-destructive" @select="requestDelete(bridge)"><Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span></DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="editorOpen" @update:open="handleEditorOpenChange">
    <DialogContent class="chat-editor-dialog w-[min(680px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="chat-editor-head space-y-0">
        <div><DialogTitle>{{ t("settings.chatBridge.edit") }}</DialogTitle><DialogDescription>{{ t("settings.chatBridge.editDescription", { channel: selectedChatBridge ? chatChannelLabel(selectedChatBridge.channel) : '' }) }}</DialogDescription></div>
        <Button variant="ghost" size="icon" :aria-label="t('common.actions.close')" @click="requestCloseEditor"><X :size="16" /></Button>
      </DialogHeader>
      <ScrollArea class="chat-editor-scroll" :horizontal="false">
        <form v-if="selectedChatBridge" class="chat-editor-form" @submit.prevent="saveAndClose">
          <section v-if="selectedChatStatus?.error" class="chat-editor-error" role="alert"><AlertTriangle :size="16" /><div><strong>{{ t("settings.chatBridge.bridgeError") }}</strong><span>{{ selectedChatStatus.error }}</span></div></section>

          <section class="chat-form-section">
            <header><h3>{{ t("settings.chatBridge.basicInformation") }}</h3><p>{{ t("settings.chatBridge.basicInformationDescription") }}</p></header>
            <div class="chat-form-grid">
              <label><span>{{ t("settings.chatBridge.name") }}</span><ControlPlaneInput v-model="chatForm.name" :placeholder="t('settings.chatBridge.bridgeName')" /></label>
              <label><span>{{ t("settings.chatBridge.channel") }}</span><ControlPlaneInput :model-value="chatChannelLabel(selectedChatBridge.channel)" disabled /></label>
            </div>
          </section>

          <section class="chat-form-section">
            <header><h3>{{ t("settings.chatBridge.connection") }}</h3><p>{{ t("settings.chatBridge.connectionDescription") }}</p></header>
            <label><span>{{ credentialLabel }}</span><ControlPlaneInput v-model="chatForm.token" :type="selectedChatBridge.channel === 'lark' ? 'text' : 'password'" :placeholder="selectedChatBridge.tokenSet ? t('settings.chatBridge.keepSecret') : chatTokenPlaceholder" /></label>
            <div v-if="selectedChatBridge.channel === 'wechat'" class="chat-form-grid">
              <label><span>{{ t("settings.chatBridge.contextToken") }}</span><ControlPlaneInput v-model="chatForm.settings.contextToken" type="password" :placeholder="t('settings.chatBridge.contextTokenPlaceholder')" /></label>
              <label>
                <span>{{ t("settings.chatBridge.baseUrl") }}</span>
                <!-- i18n-audit-allow-next-line code-token: WeChat API endpoint example -->
                <ControlPlaneInput v-model="chatForm.settings.baseUrl" placeholder="https://ilinkai.weixin.qq.com" />
              </label>
              <label><span>{{ t("settings.chatBridge.updatesCursor") }}</span><ControlPlaneInput v-model="chatForm.settings.updatesBuf" :placeholder="t('settings.chatBridge.savedAutomatically')" /></label>
            </div>
            <div v-else-if="selectedChatBridge.channel === 'dingding'" class="chat-form-grid">
              <label><span>{{ t("settings.chatBridge.clientSecret") }}</span><ControlPlaneInput v-model="chatForm.settings.clientSecret" type="password" :placeholder="selectedChatBridge.settings.clientSecretSet ? t('settings.chatBridge.keepSecret') : t('settings.chatBridge.clientSecret')" /></label>
              <label><span>{{ t("settings.chatBridge.robotCode") }}</span><ControlPlaneInput v-model="chatForm.settings.robotCode" :placeholder="t('settings.chatBridge.robotCodePlaceholder')" /></label>
              <label><span>{{ t("settings.chatBridge.corpId") }}</span><ControlPlaneInput v-model="chatForm.settings.corpId" :placeholder="t('settings.chatBridge.optional')" /></label>
            </div>
            <div v-else-if="selectedChatBridge.channel === 'lark'" class="chat-form-grid">
              <label><span>{{ t("settings.chatBridge.appSecret") }}</span><ControlPlaneInput v-model="chatForm.settings.appSecret" type="password" :placeholder="selectedChatBridge.settings.appSecretSet ? t('settings.chatBridge.keepSecret') : t('settings.chatBridge.appSecret')" /></label>
              <label><span>{{ t("settings.chatBridge.domain") }}</span><ControlPlaneSelect v-model="chatForm.settings.domain"><ControlPlaneSelectItem value="feishu">{{ t("settings.chatBridge.feishuChina") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="lark">{{ t("settings.chatBridge.larkGlobal") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            </div>
          </section>

          <section class="chat-form-section">
            <header><h3>{{ t("settings.chatBridge.routing") }}</h3><p>{{ t("settings.chatBridge.routingDescription") }}</p></header>
            <div class="chat-form-grid">
              <label><span>{{ selectedChatBridge.channel === 'dingding' ? t('settings.chatBridge.conversationId') : t('settings.chatBridge.defaultChatId') }}</span><ControlPlaneInput v-model="chatForm.defaultChatId" :placeholder="defaultChatPlaceholder" /></label>
              <label v-if="selectedChatBridge.channel === 'telegram'"><span>{{ t("settings.chatBridge.pollInterval") }}</span><ControlPlaneInput v-model="chatForm.pollIntervalMs" type="number" placeholder="3000" /></label>
            </div>
            <label><span>{{ t("settings.chatBridge.allowedUsers") }}</span><Textarea v-model="chatAllowedUsersText" rows="3" :placeholder="selectedChatBridge.channel === 'lark' ? t('settings.chatBridge.larkAllowedUsersPlaceholder') : t('settings.chatBridge.allowedUsersPlaceholder')" /></label>
          </section>
        </form>
      </ScrollArea>
      <DialogFooter class="chat-editor-footer">
        <Button variant="outline" @click="requestCloseEditor">{{ t("common.actions.cancel") }}</Button>
        <Button v-if="selectedChatBridge" variant="outline" :disabled="chatBridgeBusy" @click="toggleSelectedChatBridge"><Power :size="14" /><span>{{ chatBridgeRunning(selectedChatBridge.id) ? t("instances.actions.stop") : t("instances.actions.start") }}</span></Button>
        <Button :disabled="chatBridgeBusy || !chatForm.name.trim()" @click="saveAndClose"><span>{{ savingChatBridge ? t("settings.chatBridge.saving") : t("settings.chatBridge.save") }}</span></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="Boolean(pendingDelete)" @update:open="handleDeleteOpenChange">
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ t("settings.chatBridge.deleteTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.chatBridge.deleteConfirm", { name: pendingDelete?.name || '' }) }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><Button variant="destructive" size="sm" :disabled="chatBridgeBusy" @click="confirmDelete(deleteCandidate)">{{ t("common.actions.delete") }}</Button></AlertDialogFooter></AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="closeConfirmationOpen" @update:open="closeConfirmationOpen = $event">
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ t("settings.chatBridge.discardTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.chatBridge.discardDescription") }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction @click="discardAndClose">{{ t("settings.chatBridge.discard") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ChevronDown, Clock3, MessageCircle, MessageCircleMore, MoreHorizontal, Plus, Power, RefreshCw, Search, Settings, Trash2, Users, X } from "@lucide/vue";
import type { ChatBridgeConfig, ChatChannel } from "../../../api/types";
import type { useChatBridgeSettings } from "./useChatBridgeSettings";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const { t } = useI18n();
const props = defineProps<{ chat: ReturnType<typeof useChatBridgeSettings>; errorText: (error: unknown) => string; gatewayError: unknown; isRefreshing: boolean; refreshChat: () => Promise<void> }>();
const { chatAllowedUsersText, chatBridgeBusy, chatBridgeDotClass, chatBridgeRunning, chatBridgeRuntimeLine, chatBridgeStatus, chatChannelLabel, chatChannels, chatDraftDirty, chatForm, chatTokenPlaceholder, createBridge, creatingChatBridge, orderedChatBridges, removeChatBridge, saveSelectedChatBridge, savingChatBridge, selectChatBridge, selectedChatBridge, selectedChatStatus, toggleChatBridge, toggleSelectedChatBridge } = props.chat;

const searchQuery = ref("");
const channelFilter = ref<ChatChannel | "all">("all");
const statusFilter = ref<"all" | "running" | "stopped" | "error">("all");
const editorOpen = ref(false);
const closeConfirmationOpen = ref(false);
const pendingDelete = ref<ChatBridgeConfig>();
const deleteCandidate = ref<ChatBridgeConfig>();
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim()) || channelFilter.value !== "all" || statusFilter.value !== "all");
const filteredBridges = computed(() => orderedChatBridges.value.filter((bridge) => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  const matchesQuery = !query || `${bridge.name} ${chatChannelLabel(bridge.channel)} ${bridge.defaultChatId || ""}`.toLocaleLowerCase().includes(query);
  const matchesChannel = channelFilter.value === "all" || bridge.channel === channelFilter.value;
  const status = chatBridgeStatus(bridge.id);
  const matchesStatus = statusFilter.value === "all" || (statusFilter.value === "error" ? Boolean(status?.error) : statusFilter.value === "running" ? Boolean(status?.running) : !status?.running && !status?.error);
  return matchesQuery && matchesChannel && matchesStatus;
}));
const credentialLabel = computed(() => selectedChatBridge.value?.channel === "dingding" ? t("settings.chatBridge.clientId") : selectedChatBridge.value?.channel === "lark" ? t("settings.chatBridge.appId") : t("settings.chatBridge.token"));
const defaultChatPlaceholder = computed(() => selectedChatBridge.value?.channel === "wechat" ? t("settings.chatBridge.wechatIdPlaceholder") : selectedChatBridge.value?.channel === "dingding" ? t("settings.chatBridge.conversationIdPlaceholder") : selectedChatBridge.value?.channel === "lark" ? t("settings.chatBridge.larkChatIdPlaceholder") : "123456789");

function bridgeStatusLabel(bridge: ChatBridgeConfig) { const status = chatBridgeStatus(bridge.id); return status?.error ? t("settings.chatBridge.statusError") : status?.running ? t("common.status.running") : t("common.status.stopped"); }
function clearFilters() { searchQuery.value = ""; channelFilter.value = "all"; statusFilter.value = "all"; }
async function openEditor(bridge: ChatBridgeConfig) { selectChatBridge(bridge.id); await nextTick(); editorOpen.value = true; }
async function createAndEdit(channel: ChatChannel) { const bridge = await createBridge(channel); if (bridge) await openEditor(bridge); }
function handleEditorOpenChange(open: boolean) { if (open) editorOpen.value = true; else requestCloseEditor(); }
function requestCloseEditor() { if (chatDraftDirty.value) closeConfirmationOpen.value = true; else editorOpen.value = false; }
function discardAndClose() { closeConfirmationOpen.value = false; editorOpen.value = false; }
async function saveAndClose() { if (await saveSelectedChatBridge()) editorOpen.value = false; }
function requestDelete(bridge: ChatBridgeConfig) { deleteCandidate.value = bridge; pendingDelete.value = bridge; }
function handleDeleteOpenChange(open: boolean) { if (!open && !chatBridgeBusy.value) pendingDelete.value = undefined; }
async function confirmDelete(bridge?: ChatBridgeConfig) { if (!bridge) return; const deletingEditedBridge = selectedChatBridge.value?.id === bridge.id; if (await removeChatBridge(bridge)) { pendingDelete.value = undefined; deleteCandidate.value = undefined; if (deletingEditedBridge) editorOpen.value = false; } }
</script>

<style scoped>
.chat-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.chat-settings-page { display: grid; gap: 12px; padding: 0 10px 20px 0; width: 100%; }
.chat-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.chat-page-head p, .chat-form-section h3, .chat-form-section p { margin: 0; }
.chat-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.chat-head-actions { display: flex; gap: 8px; }
.chat-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px,1fr) 180px 160px; }
.chat-search { align-items: center; display: flex; position: relative; }
.chat-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.chat-search :deep(input) { padding-left: 32px; }
.chat-diagnostics { align-items: center; background: var(--status-danger-bg); border: 1px solid var(--status-danger-border); border-radius: 8px; color: var(--status-danger); display: grid; gap: 10px; grid-template-columns: auto minmax(0,1fr) auto; padding: 9px 12px; }
.chat-diagnostics > div, .chat-editor-error > div { display: grid; gap: 2px; }
.chat-diagnostics strong, .chat-editor-error strong { font-size: 13px; font-weight: 500; }
.chat-diagnostics span, .chat-editor-error span { font-size: 12px; }
.chat-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.chat-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.chat-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.chat-directory-head span { color: var(--text-muted); font-size: 12px; }
.chat-row + .chat-row { border-top: 1px solid var(--line); }
.chat-row-main { align-items: center; display: grid; gap: 14px; grid-template-columns: minmax(260px,1.3fr) minmax(260px,1fr) auto auto; min-height: 76px; padding: 10px 12px; }
.chat-identity { align-items: flex-start; display: grid; gap: 10px; grid-template-columns: auto minmax(0,1fr); min-width: 0; }
.chat-identity > div { display: grid; gap: 5px; min-width: 0; }
.chat-title-line { align-items: center; display: flex; gap: 7px; min-width: 0; }
.chat-title-line strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-identity > div > span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-identity .chat-runtime-error { color: var(--status-danger); }
.chat-status-dot { background: var(--text-subtle); border-radius: 999px; box-shadow: 0 0 0 3px var(--surface-subtle); height: 8px; margin-top: 5px; width: 8px; }
.chat-status-dot.status-online { background: var(--status-success); box-shadow: 0 0 0 3px var(--brand-accent-soft); }
.chat-status-dot.status-failed { background: var(--status-danger); box-shadow: 0 0 0 3px var(--status-danger-bg); }
.chat-summary { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.chat-summary span { align-items: center; color: var(--text-muted); display: inline-flex; font-size: 12px; gap: 5px; }
.chat-row-status, .chat-row-actions { align-items: center; display: flex; }
.chat-row-actions { gap: 4px; justify-content: flex-end; }
.chat-empty-state { align-items: center; color: var(--text-muted); display: grid; justify-items: center; min-height: 220px; padding: 28px; text-align: center; }
.chat-empty-state strong { color: var(--text-strong); font-size: 14px; font-weight: 500; margin-top: 10px; }
.chat-empty-state p { font-size: 12px; margin: 5px 0 12px; }
:global(.chat-editor-dialog) { display: grid; grid-template-rows: auto minmax(0,1fr) auto; height: min(680px,calc(100vh - 40px)); }
.chat-editor-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-direction: row; justify-content: space-between; padding: 13px 16px; }
.chat-editor-head > div { display: grid; gap: 4px; }
.chat-editor-scroll { min-height: 0; }
.chat-editor-form { display: grid; gap: 16px; padding: 14px 16px 18px; }
.chat-editor-error { align-items: flex-start; background: var(--status-danger-bg); border: 1px solid var(--status-danger-border); border-radius: 7px; color: var(--status-danger); display: flex; gap: 9px; padding: 10px; }
.chat-form-section { display: grid; gap: 10px; }
.chat-form-section + .chat-form-section { border-top: 1px solid var(--line); padding-top: 15px; }
.chat-form-section > header { display: grid; gap: 3px; }
.chat-form-section h3 { color: var(--text-strong); font-size: 14px; font-weight: 600; }
.chat-form-section p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.chat-form-section label { display: grid; gap: 6px; }
.chat-form-section label > span { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.chat-form-grid { display: grid; gap: 9px; grid-template-columns: repeat(2,minmax(0,1fr)); }
.chat-editor-footer { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media(max-width:900px) { .chat-row-main { grid-template-columns: minmax(220px,1fr) minmax(210px,.8fr) auto; } .chat-row-actions { grid-column: 3; grid-row: 1; } .chat-row-status { display: none; } }
@media(max-width:720px) { .chat-settings-page { padding-right: 7px; } .chat-toolbar { grid-template-columns: 1fr 1fr; } .chat-search { grid-column: 1/-1; } .chat-row-main { align-items: start; grid-template-columns: 1fr auto; } .chat-summary { grid-column: 1/-1; } .chat-row-actions { grid-column: 2; } .chat-form-grid { grid-template-columns: 1fr; } }
</style>
