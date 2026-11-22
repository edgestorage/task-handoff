<template>
  <div class="embedded-browser" :class="{ 'start-page-active': showStartPage }" :data-state="state">
    <div class="embedded-browser-toolbar">
      <Button variant="ghost" size="icon" :disabled="!canGoBack" :title="t('sessions.browser.back')" :aria-label="t('sessions.browser.back')" @click="goBack">
        <ArrowLeft :size="15" />
      </Button>
      <Button variant="ghost" size="icon" :disabled="!canGoForward" :title="t('sessions.browser.forward')" :aria-label="t('sessions.browser.forward')" @click="goForward">
        <ArrowRight :size="15" />
      </Button>
      <Button variant="ghost" size="icon" :title="loading ? t('sessions.browser.stop') : t('sessions.browser.reload')" :aria-label="loading ? t('sessions.browser.stop') : t('sessions.browser.reload')" @click="loading ? stop() : reload()">
        <X v-if="loading" :size="15" />
        <RotateCw v-else :size="15" />
      </Button>
      <Popover :open="suggestionsOpen" @update:open="handleSuggestionsOpenChange">
        <PopoverAnchor as-child>
          <form ref="addressAnchor" class="embedded-browser-address" @submit.prevent="submitAddress">
            <Globe2 :size="14" />
            <input
              ref="addressInput"
              v-model="address"
              type="text"
              inputmode="url"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="suggestionsOpen"
              :aria-controls="suggestionsOpen ? suggestionsListId : undefined"
              :aria-activedescendant="activeSuggestionId"
              :aria-label="t('sessions.browser.address')"
              @focus="handleAddressFocus"
              @input="handleAddressInput"
              @keydown="handleAddressKeydown"
            />
          </form>
        </PopoverAnchor>
        <PopoverContent
          v-if="suggestions.length"
          class="embedded-browser-suggestions"
          align="start"
          side="bottom"
          :side-offset="5"
          :collision-padding="8"
          :style="{ width: 'var(--reka-popover-trigger-width)', padding: '4px' }"
          @open-auto-focus.prevent
          @close-auto-focus.prevent
          @interact-outside="handleSuggestionsInteractOutside"
        >
          <ScrollArea class="embedded-browser-suggestions-scroll" :horizontal="false">
            <div :id="suggestionsListId" class="embedded-browser-suggestions-list" role="listbox">
              <button
                v-for="(suggestion, index) in suggestions"
                :id="suggestionOptionId(index)"
                :key="suggestion.id"
                type="button"
                role="option"
                class="embedded-browser-suggestion"
                :class="{ 'embedded-browser-suggestion-active': activeSuggestionIndex === index }"
                :aria-selected="activeSuggestionIndex === index"
                @pointerdown.prevent
                @pointerenter="activeSuggestionIndex = index"
                @click="selectSuggestion(suggestion)"
              >
                <Pin v-if="suggestion.kind === 'pinned'" :size="14" />
                <History v-else :size="14" />
                <span class="embedded-browser-suggestion-copy"><span>{{ suggestion.title }}</span><small>{{ suggestion.url }}</small></span>
              </button>
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      <Popover :open="agentAccessOpen" @update:open="handleAgentAccessOpenChange">
        <PopoverAnchor as-child>
          <Button
            variant="ghost"
            size="icon"
            class="embedded-browser-agent-access"
            :class="{ 'embedded-browser-agent-access-active': browserControlAccess.active }"
            :title="agentAccessTitle"
            :aria-label="agentAccessTitle"
            @click="agentAccessOpen = !agentAccessOpen"
          >
            <Bot :size="15" />
          </Button>
        </PopoverAnchor>
        <PopoverContent class="embedded-browser-agent-access-menu" align="end" side="bottom" :side-offset="5" :collision-padding="8">
          <strong>{{ t("sessions.browser.agentAccess") }}</strong>
          <p>{{ agentAccessHint }}</p>
          <div class="embedded-browser-agent-access-actions">
            <Button
              size="sm"
              :variant="browserControlAccess.active ? 'ghost' : 'default'"
              :disabled="agentAccessBusy || agentAccessLoading"
              @click="browserControlAccess.active ? revokeBrowserControlAccessForInstance() : grantBrowserControlAccessForInstance()"
            >
              {{ t(browserControlAccess.active ? "sessions.browser.agentAccessRevoke" : "sessions.browser.agentAccessGrant") }}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
    <div class="embedded-browser-surface">
      <p v-if="pageHostNotice" class="embedded-browser-host-notice" role="status">{{ pageHostNotice }}</p>
      <section v-if="creationApprovals.length" class="embedded-browser-creation-approvals" aria-live="polite">
        <article v-for="approval in creationApprovals" :key="approval.request.creationRef" class="embedded-browser-creation-card">
          <div class="embedded-browser-creation-copy">
            <strong>{{ t("sessions.browser.creationTitle") }}</strong>
            <span :title="approval.request.requestedUrl">{{ approval.request.requestedUrl }}</span>
            <small>{{ t("sessions.browser.creationMeta", { session: shortSessionRef(approval.requesterSessionRef), host: creationHostLabel(approval) }) }}</small>
          </div>
          <div class="embedded-browser-creation-actions">
            <Button size="sm" variant="outline" :disabled="Boolean(creationActionRef)" @click="resolveCreation(approval, 'claim')">{{ t("sessions.browser.creationApprove") }}</Button>
            <Button size="sm" variant="ghost" :disabled="Boolean(creationActionRef)" @click="resolveCreation(approval, 'decline')">{{ t("sessions.browser.creationDecline") }}</Button>
          </div>
        </article>
        <p v-if="creationError" class="embedded-browser-creation-error" role="alert">{{ creationError }}</p>
      </section>
      <webview v-if="context?.partition" ref="guest" src="about:blank" :partition="context.partition" allowpopups @dom-ready="handleGuestDomReady" />
      <div v-if="showStartPage" class="embedded-browser-start-page">
        <section class="embedded-browser-start-section">
          <div class="embedded-browser-start-heading"><h2>{{ t("sessions.browser.pinned") }}</h2><button type="button" class="embedded-browser-add" :aria-label="t('sessions.browser.addPinned')" @pointerdown.stop @click.stop="addPinned"><Plus :size="14" /></button></div>
          <div v-if="pinned.length" class="embedded-browser-start-grid">
            <div v-for="item in pinned" :key="item.id" class="embedded-browser-start-item" role="button" tabindex="0" @click="navigate(item.url)" @keydown.enter="navigate(item.url)"><span class="embedded-browser-start-icon">{{ item.name.slice(0, 1).toUpperCase() }}</span><span class="embedded-browser-start-label">{{ item.name }}</span><button type="button" class="embedded-browser-unpin" :aria-label="t('sessions.browser.removePinned')" @click.stop="removePinned(item.id)"><X :size="13" /></button></div>
          </div>
          <p v-else class="embedded-browser-start-empty">{{ t("sessions.browser.noPinned") }}</p>
        </section>
        <section class="embedded-browser-start-section">
          <div class="embedded-browser-start-heading"><h2>{{ t("sessions.browser.recent") }}</h2><button v-if="recent.length" type="button" class="embedded-browser-clear" @click="clearRecent">{{ t("sessions.browser.clearRecent") }}</button></div>
          <div v-if="recent.length" class="embedded-browser-start-list"><button v-for="item in recent" :key="item.url" type="button" class="embedded-browser-recent-item" @click="navigate(item.url)"><span>{{ item.title || item.url }}</span><small>{{ item.url }}</small></button></div>
          <p v-else class="embedded-browser-start-empty">{{ t("sessions.browser.noRecent") }}</p>
        </section>
      </div>
      <div v-if="state === 'preparing' || state === 'error'" class="embedded-browser-state">
        <LoaderCircle v-if="state === 'preparing'" :size="24" />
        <CircleAlert v-else :size="24" />
        <p class="embedded-browser-state-message">{{ state === "preparing" ? t("sessions.browser.connecting") : error }}</p>
        <p v-if="state === 'error' && errorDetail" class="embedded-browser-state-detail">{{ errorDetail }}</p>
        <Button v-if="state === 'error'" variant="outline" size="sm" @click="retry"><RotateCw :size="14" />{{ t("sessions.browser.retry") }}</Button>
      </div>
    </div>
  </div>
  <Dialog v-model:open="pinnedDialogOpen">
    <DialogContent class="embedded-browser-pinned-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("sessions.browser.addPinnedTitle") }}</DialogTitle>
        <DialogDescription>{{ t("sessions.browser.addPinnedDescription") }}</DialogDescription>
      </DialogHeader>
      <form class="embedded-browser-pinned-form" @submit.prevent="savePinned">
        <label for="embedded-browser-pinned-name">{{ t("sessions.browser.pinnedName") }}</label>
        <Input id="embedded-browser-pinned-name" v-model="pinnedName" autocomplete="off" autofocus required />
        <label for="embedded-browser-pinned-url">{{ t("sessions.browser.pinnedUrl") }}</label>
        <Input id="embedded-browser-pinned-url" v-model="pinnedUrl" type="url" inputmode="url" autocomplete="url" required />
        <p v-if="pinnedDialogError" class="embedded-browser-pinned-error" role="alert">{{ pinnedDialogError }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="pinnedDialogOpen = false">{{ t("common.actions.cancel") }}</Button>
          <Button type="submit"><Plus :size="14" />{{ t("sessions.browser.savePinned") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, ArrowRight, Bot, CircleAlert, Globe2, History, LoaderCircle, Pin, Plus, RotateCw, X } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { EmbeddedBrowserAccessView, EmbeddedBrowserCreationApprovalView } from "@task-handoff/protocol/embedded-browser-control";
import { claimBrowserCreation, declineBrowserCreation, getBrowserControlAccess, grantBrowserControlAccess, listBrowserCreationApprovals, revokeBrowserControlAccess } from "../../../api/browserControl";
import { canRenewDesktopBrowserContext, getDesktopBrowserControlInfo, logDesktopBrowserDiagnostic, onDesktopBrowserFocusAddress, onDesktopBrowserLoadFailure, onDesktopBrowserTabClosed, prepareDesktopBrowserContext, registerDesktopBrowserTab, releaseDesktopBrowserContext, setDesktopBrowserTabThrottled, touchDesktopBrowserContext, unregisterDesktopBrowserTab, updateDesktopBrowserTab } from "../../../lib/desktopBridge";
import { BROWSER_ACCESS_CHANGED_EVENT, BROWSER_CREATION_CHANGED_EVENT, BROWSER_CREATION_REFRESH_EVENT, type BrowserCreationEventDetail } from "./browserCreationEvents";
import { createBrowserUuid } from "../../../lib/random-id";
import { browserFailureTarget, browserLoadFailureKey } from "./browserLoadFailure";
import { browserAddressSuggestions, normalizeDesktopBrowserUrl, sanitizeBrowserStartPageData, type BrowserAddressSuggestion, type PinnedBrowserShortcut, type RecentBrowserPage } from "./browserAddressSuggestions";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type GuestWebView = HTMLElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle?(): string;
  getWebContentsId?(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
};

const props = defineProps<{ instanceId: string; sessionKey?: string; initialUrl?: string; creationRef?: string; backgroundThrottled?: boolean }>();
const emit = defineEmits<{
  updateTab: [patch: { title?: string; url?: string; status?: string }];
  closeTab: [];
}>();
const { t } = useI18n();
const guest = ref<GuestWebView>();
const addressAnchor = ref<HTMLFormElement>();
const addressInput = ref<HTMLInputElement>();
const context = ref<{ contextId: string; partition: string }>();
const address = ref("");
const error = ref("");
const errorDetail = ref("");
const state = ref<"preparing" | "ready" | "error">("preparing");
const pageHostNotice = ref("");
const browserSourceRef = ref<string>();
const creationApprovals = ref<EmbeddedBrowserCreationApprovalView[]>([]);
const creationActionRef = ref("");
const creationError = ref("");
const agentAccessOpen = ref(false);
const browserControlAccess = ref<EmbeddedBrowserAccessView>({ active: false, revision: 0 });
const agentAccessLoading = ref(false);
const agentAccessBusy = ref(false);
let agentAccessRequestRevision = 0;
const agentAccessTitle = computed(() => t("sessions.browser.agentAccess"));
const agentAccessHint = computed(() => t(
  browserControlAccess.value.active
    ? "sessions.browser.agentAccessRevokeHint"
    : "sessions.browser.agentAccessGrantHint",
));
const loading = ref(false);
const pinned = ref<PinnedBrowserShortcut[]>([]);
const recent = ref<RecentBrowserPage[]>([]);
const suggestionsOpen = ref(false);
const activeSuggestionIndex = ref(-1);
const suggestionsListId = `embedded-browser-suggestions-${createBrowserUuid()}`;
const localSessionKey = props.sessionKey?.trim() || `embedded-browser:${createBrowserUuid()}`;
const suggestions = computed(() => browserAddressSuggestions(pinned.value, recent.value, address.value));
const activeSuggestionId = computed(() => activeSuggestionIndex.value >= 0 ? suggestionOptionId(activeSuggestionIndex.value) : undefined);
const showStartPage = ref(true);
const pinnedDialogOpen = ref(false);
const pinnedName = ref("");
const pinnedUrl = ref("");
const pinnedDialogError = ref("");
const pendingNavigation = ref("");
let navigationSequence = 0;
let suppressBlankNavigation = false;
const canGoBack = ref(false);
const canGoForward = ref(false);
let removeGuestListeners: (() => void) | undefined;
let contextHeartbeat: ReturnType<typeof setInterval> | undefined;
let recoveringContext = false;
let disposed = false;
let guestDomReady = false;
let stopBrowserFocusAddress: (() => void) | undefined;
let resolveGuestDomReady: (() => void) | undefined;
let guestDomReadyPromise: Promise<void>;
let removeLoadFailureListener: (() => void) | undefined;
let removeTabClosedListener: (() => void) | undefined;
let removeCreationChangedListener: (() => void) | undefined;
let removeCreationRefreshListener: (() => void) | undefined;
let removeAccessChangedListener: (() => void) | undefined;
let lastChromiumError: { code?: number; description?: string } | undefined;
let tunnelFailure: { host?: string; port?: number; code?: string; message?: string } | undefined;
let lastFailureUrl = "";
let registeredTabRef: string | undefined;
let registeringTab = false;
function resetGuestReady() {
  guestDomReady = false;
  guestDomReadyPromise = new Promise<void>((resolve) => { resolveGuestDomReady = resolve; });
}
resetGuestReady();

function resetLoadFailure() {
  lastChromiumError = undefined;
  tunnelFailure = undefined;
  lastFailureUrl = "";
  errorDetail.value = "";
}

function publishTabPatch(patch: { title?: string; url?: string; status?: string }) {
  emit("updateTab", patch);
  if (!registeredTabRef) return;
  void updateDesktopBrowserTab({ tabRef: registeredTabRef, ...patch }).then((result) => {
    if (!result.ok && !disposed) logDesktopBrowserDiagnostic(`browser tab update rejected code=${result.code || ""}`, props.instanceId);
  }).catch((cause) => {
    if (!disposed) logDesktopBrowserDiagnostic(`browser tab update failed error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
  });
}

async function registerGuestTab() {
  const view = guest.value;
  const webContentsId = view?.getWebContentsId?.();
  if (!Number.isInteger(webContentsId) || registeringTab) return;
  registeringTab = true;
  try {
    const result = await registerDesktopBrowserTab({
      webContentsId: webContentsId!,
      instanceId: props.instanceId,
      sessionKey: localSessionKey,
      ...(props.creationRef ? { creationRef: props.creationRef } : {}),
      title: view?.getTitle?.() || undefined,
      url: view?.getURL?.() || address.value || "about:blank",
      state: state.value,
    });
    if (disposed || context.value?.partition == null) {
      if (result.ok) void unregisterDesktopBrowserTab(webContentsId!);
      return;
    }
    if (!result.ok || !result.tab) {
      logDesktopBrowserDiagnostic(`browser tab registration rejected code=${result.code || ""}`, props.instanceId);
      return;
    }
    registeredTabRef = result.tab.tabRef;
    logDesktopBrowserDiagnostic(`browser tab registered tabRef=${registeredTabRef} pageHost=${result.tab.pageHost}`, props.instanceId);
  } catch (cause) {
    logDesktopBrowserDiagnostic(`browser tab registration failed error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
  } finally {
    registeringTab = false;
  }
}

function unregisterGuestTab() {
  const webContentsId = guest.value?.getWebContentsId?.();
  registeredTabRef = undefined;
  if (Number.isInteger(webContentsId)) void unregisterDesktopBrowserTab(webContentsId!).catch(() => undefined);
}

function clearLoadFailure() {
  resetLoadFailure();
  error.value = "";
  if (state.value === "error") state.value = "ready";
}

function showLoadFailure() {
  state.value = "error";
  error.value = t(browserLoadFailureKey({ chromiumCode: lastChromiumError?.code, tunnelCode: tunnelFailure?.code }));
  const chromium = lastChromiumError?.description
    ? `${lastChromiumError.description}${typeof lastChromiumError.code === "number" ? ` (${lastChromiumError.code})` : ""}`
    : "";
  errorDetail.value = [browserFailureTarget(lastFailureUrl), tunnelFailure?.code || "", chromium].filter(Boolean).join(" · ");
}

function chromiumCodeFromMessage(message: string) {
  const match = /\((-?\d+)\)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function handleLoadFailure(input: { instanceId?: string; host?: string; port?: number; code?: string; message?: string }) {
  if (input?.instanceId && input.instanceId !== props.instanceId) return;
  tunnelFailure = input;
  // The webview reports its own failure too; only refine a prompt that is
  // already on screen so a stray tunnel failure never hijacks the browser.
  if (state.value === "error") showLoadFailure();
}

async function establishContext() {
  let result;
  try {
    result = await prepareDesktopBrowserContext(props.instanceId);
    logDesktopBrowserDiagnostic(`browser context result ok=${result.ok} partition=${result.partition || ""}`, props.instanceId);
  } catch (cause) {
    logDesktopBrowserDiagnostic(`browser context threw error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
    state.value = "error";
    error.value = cause instanceof Error && cause.message ? cause.message : t("sessions.browser.unavailable");
    return false;
  }
  if (disposed) {
    if (result.ok && result.contextId) void releaseDesktopBrowserContext(result.contextId);
    return false;
  }
  if (!result.ok || !result.contextId || !result.partition) {
    state.value = "error";
    error.value = result.message || (result.code ? `${t("sessions.browser.unavailable")} (${result.code})` : t("sessions.browser.unavailable"));
    return false;
  }
  context.value = { contextId: result.contextId, partition: result.partition };
  await nextTick();
  if (disposed) return false;
  logDesktopBrowserDiagnostic(`browser webview rendered partition=${result.partition}`, props.instanceId);
  bindGuest();
  state.value = "ready";
  startContextHeartbeat(result.contextId);
  const initialUrl = props.initialUrl?.trim();
  if (!initialUrl || initialUrl === "about:blank") {
    logDesktopBrowserDiagnostic("browser start page ready", props.instanceId);
    publishTabPatch({ status: "running" });
  }
  if (initialUrl && initialUrl !== "about:blank") {
    showStartPage.value = false;
    let url: string;
    try {
      url = normalizeDesktopBrowserUrl(initialUrl);
    } catch (cause) {
      logDesktopBrowserDiagnostic(`browser initial navigation failed url=${initialUrl.slice(0, 200)} error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
      error.value = t("sessions.browser.invalidUrl");
      return false;
    }
    address.value = url;
    logDesktopBrowserDiagnostic(`browser initial navigation url=${url.slice(0, 200)}`, props.instanceId);
    pendingNavigation.value = url;
    void dispatchPendingNavigation(++navigationSequence);
  }
  return true;
}

async function loadPageHostDiagnostic() {
  const info = await getDesktopBrowserControlInfo(props.instanceId).catch(() => undefined);
  if (!info?.ok || disposed) return;
  browserSourceRef.value = info.sourceRef;
  if (!info.degraded) return;
  pageHostNotice.value = t("sessions.browser.pageHostDegraded");
  logDesktopBrowserDiagnostic(`browser pageHost degraded requested=${info.requestedPageHost || ""} actual=${info.pageHost || ""} reason=${info.degradedReason || ""}`, props.instanceId);
}

function creationCandidate(approval: EmbeddedBrowserCreationApprovalView) {
  return approval.request.candidates.find((candidate) => candidate.sourceRef === browserSourceRef.value && candidate.canCreate);
}

function creationHostLabel(approval: EmbeddedBrowserCreationApprovalView) {
  const candidate = creationCandidate(approval);
  return candidate?.hostLabel || candidate?.desktopLabel || candidate?.panelLabel || "";
}

function shortSessionRef(value: string) {
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

async function refreshCreationApprovals() {
  try {
    const info = await getDesktopBrowserControlInfo(props.instanceId);
    if (disposed) return;
    browserSourceRef.value = info.sourceRef;
    if (!info.ok || !browserSourceRef.value) {
      creationApprovals.value = [];
      return;
    }
    const snapshot = await listBrowserCreationApprovals(props.instanceId);
    if (disposed || snapshot.items.length === 0) {
      if (!disposed) creationApprovals.value = [];
      return;
    }
    creationApprovals.value = snapshot.items.filter((approval) => Boolean(creationCandidate(approval)));
  } catch (cause) {
    if (!disposed) logDesktopBrowserDiagnostic(`browser creation approvals failed error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
  }
}

async function resolveCreation(approval: EmbeddedBrowserCreationApprovalView, decision: "claim" | "decline") {
  if (!browserSourceRef.value || creationActionRef.value) return;
  creationActionRef.value = approval.request.creationRef;
  creationError.value = "";
  try {
    if (decision === "claim") {
      await claimBrowserCreation(props.instanceId, browserSourceRef.value, approval.request.creationRef, approval.request.revision);
    } else {
      await declineBrowserCreation(props.instanceId, browserSourceRef.value, approval.request.creationRef, approval.request.revision);
    }
    await refreshCreationApprovals();
  } catch (cause) {
    creationError.value = t("sessions.browser.creationActionFailed");
    logDesktopBrowserDiagnostic(`browser creation ${decision} failed error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
  } finally {
    creationActionRef.value = "";
  }
}

function stopContextHeartbeat() {
  if (contextHeartbeat) clearInterval(contextHeartbeat);
  contextHeartbeat = undefined;
}

function startContextHeartbeat(contextId: string) {
  stopContextHeartbeat();
  if (!canRenewDesktopBrowserContext()) return;
  const renewContextLease = () => {
    void touchDesktopBrowserContext(contextId).then(({ ok }) => {
      if (ok || disposed || context.value?.contextId !== contextId) return;
      logDesktopBrowserDiagnostic("browser context lease renewal rejected; rebuilding context", props.instanceId);
      void recoverContext(contextId);
    }).catch((cause) => {
      if (disposed || context.value?.contextId !== contextId) return;
      logDesktopBrowserDiagnostic(`browser context lease renewal failed; rebuilding context error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
      void recoverContext(contextId);
    });
  };
  renewContextLease();
  contextHeartbeat = setInterval(renewContextLease, 15_000);
}

async function recoverContext(lostContextId: string) {
  if (recoveringContext || disposed || context.value?.contextId !== lostContextId) return;
  recoveringContext = true;
  stopContextHeartbeat();
  unregisterGuestTab();
  removeGuestListeners?.();
  removeGuestListeners = undefined;
  resetGuestReady();
  const oldContextId = context.value?.contextId;
  context.value = undefined;
  await nextTick();
  resetLoadFailure();
  state.value = "preparing";
  loading.value = false;
  suppressBlankNavigation = false;
  if (oldContextId) await releaseDesktopBrowserContext(oldContextId).catch(() => undefined);
  try {
    await establishContext();
  } finally {
    recoveringContext = false;
  }
}

onMounted(async () => {
  loadStartPageData();
  void loadPageHostDiagnostic();
  stopBrowserFocusAddress = onDesktopBrowserFocusAddress(({ webContentsId }) => {
    if (guest.value?.getWebContentsId?.() !== webContentsId) return;
    focusAddress();
  });
  removeLoadFailureListener = onDesktopBrowserLoadFailure((input) => handleLoadFailure(input));
  removeTabClosedListener = onDesktopBrowserTabClosed(({ tabRef, instanceId }) => {
    if (instanceId && instanceId !== props.instanceId) return;
    if (!tabRef || tabRef !== registeredTabRef) return;
    emit("closeTab");
  });
  const handleCreationChanged = (event: Event) => {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (detail?.instanceId && detail.instanceId !== props.instanceId) return;
    void refreshCreationApprovals();
  };
  const handleCreationRefresh = (event: Event) => {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (detail?.instanceId && detail.instanceId !== props.instanceId) return;
    void refreshCreationApprovals();
  };
  const handleAccessChanged = (event: Event) => {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (detail?.instanceId && detail.instanceId !== props.instanceId) return;
    void refreshBrowserControlAccess();
  };
  window.addEventListener(BROWSER_CREATION_CHANGED_EVENT, handleCreationChanged);
  window.addEventListener(BROWSER_CREATION_REFRESH_EVENT, handleCreationRefresh);
  window.addEventListener(BROWSER_ACCESS_CHANGED_EVENT, handleAccessChanged);
  removeCreationChangedListener = () => window.removeEventListener(BROWSER_CREATION_CHANGED_EVENT, handleCreationChanged);
  removeCreationRefreshListener = () => window.removeEventListener(BROWSER_CREATION_REFRESH_EVENT, handleCreationRefresh);
  removeAccessChangedListener = () => window.removeEventListener(BROWSER_ACCESS_CHANGED_EVENT, handleAccessChanged);
  logDesktopBrowserDiagnostic(`browser tab mounted sessionKey=${props.sessionKey || ""}`, props.instanceId);
  await establishContext();
  await refreshCreationApprovals();
  await refreshBrowserControlAccess();
});

watch(() => [context.value?.partition, showStartPage.value] as const, async ([partition, startPage]) => {
  if (!partition) return;
  if (startPage || !pendingNavigation.value) return;
  await dispatchPendingNavigation(navigationSequence);
});

onBeforeUnmount(() => {
  disposed = true;
  logDesktopBrowserDiagnostic(`browser tab unmounted sessionKey=${props.sessionKey || ""} contextId=${context.value?.contextId || ""}`, props.instanceId);
  stopContextHeartbeat();
  stopBrowserFocusAddress?.();
  removeLoadFailureListener?.();
  removeTabClosedListener?.();
  removeCreationChangedListener?.();
  removeCreationRefreshListener?.();
  removeAccessChangedListener?.();
  unregisterGuestTab();
  removeGuestListeners?.();
  if (context.value) void releaseDesktopBrowserContext(context.value.contextId);
});

function bindGuest() {
  const view = guest.value;
  if (!view) return;
  const sync = () => {
    const url = view.getURL();
    if ((!url || url === "about:blank") && !suppressBlankNavigation && !pendingNavigation.value && !loading.value) showStartPage.value = true;
    if (!url || url === "about:blank") {
      address.value = "";
      publishTabPatch({ url: "about:blank" });
    }
    if (url && url !== "about:blank") {
      suppressBlankNavigation = false;
      showStartPage.value = false;
      address.value = url;
      publishTabPatch({ url });
      logDesktopBrowserDiagnostic(`browser sync url=${url.slice(0, 160)}`, props.instanceId);
    }
    canGoBack.value = view.canGoBack();
    canGoForward.value = view.canGoForward();
  };
  const start = () => { loading.value = true; publishTabPatch({ status: "loading" }); };
  const finishLoading = () => {
    loading.value = false;
    sync();
    const url = view.getURL();
    const title = view.getTitle?.()?.trim();
    if (url && url !== "about:blank") addRecent(url, title || url);
    logDesktopBrowserDiagnostic(`browser finish title=${(title || "").slice(0, 160)}`, props.instanceId);
    if (state.value === "error") return;
    publishTabPatch({ status: "running", ...(title ? { title } : {}) });
  };
  const stopLoading = () => { finishLoading(); };
  const titleUpdated = (event: Event & { title?: string }) => {
    const title = typeof event.title === "string" ? event.title.trim() : "";
    logDesktopBrowserDiagnostic(`browser title event title=${title.slice(0, 160)}`, props.instanceId);
    if (title) publishTabPatch({ title, status: "running" });
  };
  const failed = (event: Event & { errorCode?: number; errorDescription?: string; validatedURL?: string }) => {
    if (event.validatedURL === "about:blank") return;
    loading.value = false;
    publishTabPatch({ status: "failed" });
    lastChromiumError = { code: event.errorCode, description: event.errorDescription };
    lastFailureUrl = event.validatedURL || address.value;
    showLoadFailure();
  };
  view.addEventListener("did-start-loading", start);
  view.addEventListener("did-stop-loading", stopLoading);
  view.addEventListener("did-finish-load", finishLoading);
  view.addEventListener("did-navigate", sync);
  view.addEventListener("did-navigate-in-page", sync);
  view.addEventListener("did-fail-load", failed as EventListener);
  view.addEventListener("page-title-updated", titleUpdated as EventListener);
  removeGuestListeners = () => {
    view.removeEventListener("did-start-loading", start);
    view.removeEventListener("did-stop-loading", stopLoading);
    view.removeEventListener("did-finish-load", finishLoading);
    view.removeEventListener("did-navigate", sync);
    view.removeEventListener("did-navigate-in-page", sync);
    view.removeEventListener("did-fail-load", failed as EventListener);
    view.removeEventListener("page-title-updated", titleUpdated as EventListener);
  };
}

function applyBackgroundThrottling() {
  const id = guest.value?.getWebContentsId?.();
  if (!Number.isInteger(id)) return;
  void setDesktopBrowserTabThrottled(id!, props.backgroundThrottled !== false);
}

watch(() => props.backgroundThrottled, () => {
  // Electron throws until the guest has emitted dom-ready.
  if (guestDomReady) applyBackgroundThrottling();
});

function waitForGuestReady() {
  if (guestDomReady) return Promise.resolve();
  return Promise.race([
    guestDomReadyPromise,
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Timed out waiting for browser webview dom-ready.")), 10000)),
  ]);
}

function handleGuestDomReady() {
  applyBackgroundThrottling();
  void registerGuestTab();
  if (guestDomReady) return;
  guestDomReady = true;
  // Popup tabs mount their webview after the initial component tick. Bind here
  // as soon as Electron confirms the guest is attached to avoid missing all
  // navigation/title events for the first load.
  if (!removeGuestListeners) bindGuest();
  resolveGuestDomReady?.();
  resolveGuestDomReady = undefined;
  logDesktopBrowserDiagnostic("browser webview dom-ready", props.instanceId);
}

function navigate(value: string) {
  try {
    clearLoadFailure();
    const url = normalizeDesktopBrowserUrl(value);
    // Queue the request until Electron has confirmed the guest is ready. The
    // guest remains mounted while the start page is shown, so this also works
    // when submitting a second URL from the address bar.
    pendingNavigation.value = url;
    const sequence = ++navigationSequence;
    showStartPage.value = false;
    void dispatchPendingNavigation(sequence);
  } catch {
    error.value = t("sessions.browser.invalidUrl");
  }
}

async function dispatchPendingNavigation(sequence: number) {
  const url = pendingNavigation.value;
  if (!url) return;
  pendingNavigation.value = "";
  suppressBlankNavigation = true;
  try {
    await waitForGuestReady();
    if (disposed || sequence !== navigationSequence) return;
    await guest.value?.loadURL(url);
    logDesktopBrowserDiagnostic(`browser navigation dispatched url=${url.slice(0, 200)}`, props.instanceId);
  } catch (cause) {
    if (sequence !== navigationSequence) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    logDesktopBrowserDiagnostic(`browser navigation failed url=${url.slice(0, 200)} error=${message}`, props.instanceId);
    lastChromiumError = { code: chromiumCodeFromMessage(message), description: message.slice(0, 200) };
    lastFailureUrl = url;
    showLoadFailure();
  }
}

const storageKey = () => `taskhandoff.browser.start.${props.instanceId}`;
function loadStartPageData() {
  try {
    const parsed = sanitizeBrowserStartPageData(JSON.parse(window.localStorage.getItem(storageKey()) || "{}"));
    pinned.value = parsed.pinned;
    recent.value = parsed.recent;
  } catch { pinned.value = []; recent.value = []; }
}
function persistStartPageData() { try { window.localStorage.setItem(storageKey(), JSON.stringify({ pinned: pinned.value, recent: recent.value })); } catch { /* storage may be unavailable */ } }
function addRecent(url: string, title: string) {
  recent.value = [{ url, title, visitedAt: Date.now() }, ...recent.value.filter((item) => item.url !== url)].slice(0, 12);
  persistStartPageData();
}
function addPinned() {
  logDesktopBrowserDiagnostic("browser add pinned clicked", props.instanceId);
  pinnedName.value = "";
  pinnedUrl.value = "";
  pinnedDialogError.value = "";
  pinnedDialogOpen.value = true;
}
function savePinned() {
  const name = pinnedName.value.trim();
  const value = pinnedUrl.value.trim();
  if (!name || !value) return;
  try {
    pinned.value = [...pinned.value, { id: createBrowserUuid(), name: name.slice(0, 40), url: normalizeDesktopBrowserUrl(value) }].slice(0, 6);
    persistStartPageData();
    pinnedDialogOpen.value = false;
  } catch {
    pinnedDialogError.value = t("sessions.browser.invalidUrl");
  }
}
function removePinned(id: string) { pinned.value = pinned.value.filter((item) => item.id !== id); persistStartPageData(); }
function clearRecent() { recent.value = []; persistStartPageData(); }

function handleSuggestionsOpenChange(open: boolean) {
  suggestionsOpen.value = open && suggestions.value.length > 0;
  if (!suggestionsOpen.value) activeSuggestionIndex.value = -1;
}

function handleSuggestionsInteractOutside(event: Event) {
  const target = event.target;
  if (target instanceof Node && addressAnchor.value?.contains(target)) event.preventDefault();
}

function handleAddressFocus(event: FocusEvent) {
  (event.currentTarget as HTMLInputElement).select();
  activeSuggestionIndex.value = -1;
  suggestionsOpen.value = suggestions.value.length > 0;
}

function handleAddressInput() {
  activeSuggestionIndex.value = suggestions.value.length ? 0 : -1;
  suggestionsOpen.value = suggestions.value.length > 0;
}

function handleAddressKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    focusAddress();
    return;
  }
  if (event.key === "Escape") {
    if (!suggestionsOpen.value) return;
    event.preventDefault();
    handleSuggestionsOpenChange(false);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!suggestions.value.length) return;
    event.preventDefault();
    suggestionsOpen.value = true;
    const offset = event.key === "ArrowDown" ? 1 : -1;
    activeSuggestionIndex.value = activeSuggestionIndex.value < 0
      ? (offset > 0 ? 0 : suggestions.value.length - 1)
      : (activeSuggestionIndex.value + offset + suggestions.value.length) % suggestions.value.length;
    return;
  }
  if (event.key === "Tab" && activeSuggestionIndex.value >= 0) {
    event.preventDefault();
    address.value = suggestions.value[activeSuggestionIndex.value]?.url || address.value;
    handleSuggestionsOpenChange(false);
  }
}

function submitAddress() {
  const suggestion = suggestionsOpen.value && activeSuggestionIndex.value >= 0
    ? suggestions.value[activeSuggestionIndex.value]
    : undefined;
  handleSuggestionsOpenChange(false);
  navigate(suggestion?.url || address.value);
}

function selectSuggestion(suggestion: BrowserAddressSuggestion) {
  address.value = suggestion.url;
  handleSuggestionsOpenChange(false);
  navigate(suggestion.url);
}

function focusAddress() {
  addressInput.value?.focus();
  addressInput.value?.select();
  suggestionsOpen.value = suggestions.value.length > 0;
}

function suggestionOptionId(index: number) {
  return `${suggestionsListId}-option-${index}`;
}

function goBack() { clearLoadFailure(); guest.value?.goBack(); }
function goForward() { clearLoadFailure(); guest.value?.goForward(); }
function reload() { clearLoadFailure(); guest.value?.reload(); }
function stop() { guest.value?.stop(); }
function retry() { reload(); }

function handleAgentAccessOpenChange(open: boolean) {
  agentAccessOpen.value = open;
  if (open) void refreshBrowserControlAccess();
}

async function refreshBrowserControlAccess() {
  const revision = ++agentAccessRequestRevision;
  agentAccessLoading.value = true;
  try {
    const access = await getBrowserControlAccess(props.instanceId);
    if (revision === agentAccessRequestRevision) browserControlAccess.value = access;
  } catch {
    if (revision === agentAccessRequestRevision) {
      browserControlAccess.value = { active: false, revision: browserControlAccess.value.revision };
    }
  } finally {
    if (revision === agentAccessRequestRevision) agentAccessLoading.value = false;
  }
}

async function grantBrowserControlAccessForInstance() {
  if (agentAccessBusy.value) return;
  agentAccessBusy.value = true;
  try {
    browserControlAccess.value = await grantBrowserControlAccess(props.instanceId);
    showControlPlaneToast(t("sessions.browser.agentAccessGranted"), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.browser.agentAccessFailed")), "error");
  } finally {
    agentAccessBusy.value = false;
  }
}

async function revokeBrowserControlAccessForInstance() {
  if (agentAccessBusy.value) return;
  agentAccessBusy.value = true;
  try {
    await revokeBrowserControlAccess(props.instanceId);
    browserControlAccess.value = { active: false, revision: browserControlAccess.value.revision + 1 };
    showControlPlaneToast(t("sessions.browser.agentAccessRevoked"), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.browser.agentAccessFailed")), "error");
  } finally {
    agentAccessBusy.value = false;
  }
}
</script>

<style scoped>
.embedded-browser { display: grid; width: 100%; height: 100%; grid-template-rows: 40px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; pointer-events: auto; background: var(--surface); }
.embedded-browser-toolbar { display: flex; align-items: center; gap: 2px; min-width: 0; border-bottom: 1px solid var(--line); padding: 4px 6px; }
.embedded-browser-toolbar button { width: 30px; height: 30px; flex: 0 0 30px; }
.embedded-browser-address { display: flex; min-width: 0; height: 30px; flex: 1; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); padding: 0 9px; color: var(--text-muted); }
.embedded-browser-agent-access-active { color: var(--brand-accent); background: var(--brand-accent-soft); }
.embedded-browser-agent-access-menu { display: grid; width: min(320px, calc(100vw - 24px)); gap: 8px; }
.embedded-browser-agent-access-menu strong { color: var(--text); font-size: 13px; font-weight: 500; }
.embedded-browser-agent-access-menu p { margin: 0; color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 1.45; }
.embedded-browser-agent-access-actions { display: flex; justify-content: flex-end; }
.embedded-browser-address:focus-within { border-color: var(--brand-accent); box-shadow: 0 0 0 2px var(--brand-accent-soft); }
.embedded-browser-address input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13px; font-weight: 400; }
.embedded-browser-suggestions { max-height: var(--reka-popover-content-available-height); overflow: hidden; background: var(--surface); }
.embedded-browser-suggestions-scroll { max-height: min(320px, var(--reka-popover-content-available-height)); }
.embedded-browser-suggestions-list { display: grid; gap: 2px; }
.embedded-browser-suggestion { display: grid; width: 100%; min-width: 0; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 7px; border: 0; border-radius: 4px; background: transparent; padding: 7px 8px; color: var(--text-muted); cursor: pointer; text-align: left; }
.embedded-browser-suggestion-active { background: var(--surface-hover); color: var(--text); }
.embedded-browser-suggestion-copy { display: grid; min-width: 0; gap: 2px; }
.embedded-browser-suggestion-copy > span, .embedded-browser-suggestion-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; letter-spacing: 0; }
.embedded-browser-suggestion-copy > span { color: var(--text); font-size: 13px; }
.embedded-browser-suggestion-copy > small { color: var(--text-muted); font-size: 12px; }
.embedded-browser-surface { position: relative; min-width: 0; min-height: 0; overflow: hidden; pointer-events: auto; background: #fff; }
.embedded-browser-surface webview { display: flex; width: 100%; height: 100%; }
.embedded-browser.start-page-active .embedded-browser-surface webview { visibility: hidden; }
.embedded-browser-state { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px; background: var(--surface); color: var(--text-muted); font-size: 12px; }
.embedded-browser-state > svg { color: var(--status-danger); }
.embedded-browser-state-message { max-width: 420px; margin: 0; text-align: center; color: var(--text); font-size: 13px; }
.embedded-browser-state-detail { max-width: 440px; margin: 0; overflow-wrap: anywhere; text-align: center; color: var(--text-muted); font-size: 11px; }
.embedded-browser-start-page { position: absolute; z-index: 1; inset: 0; overflow: auto; pointer-events: auto; background: var(--surface); padding: 34px clamp(20px, 6vw, 80px); }
.embedded-browser-start-section { max-width: 920px; margin: 0 auto 30px; }
.embedded-browser-start-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.embedded-browser-start-heading h2 { margin: 0; color: var(--text); font-size: 14px; font-weight: 500; }
.embedded-browser-add, .embedded-browser-clear, .embedded-browser-unpin { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; pointer-events: auto; }
.embedded-browser-add { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 6px; }
.embedded-browser-clear { font-size: 12px; }
.embedded-browser-start-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.embedded-browser-start-item, .embedded-browser-recent-item { position: relative; display: flex; min-width: 0; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-inset); color: var(--text); cursor: pointer; text-align: left; }
.embedded-browser-start-item { align-items: center; gap: 9px; min-height: 52px; padding: 8px 30px 8px 10px; }
.embedded-browser-start-icon { display: grid; flex: 0 0 30px; width: 30px; height: 30px; place-items: center; border-radius: 6px; background: var(--brand-accent-soft); color: var(--brand-accent); font-size: 13px; font-weight: 500; }
.embedded-browser-start-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.embedded-browser-unpin { position: absolute; top: 4px; right: 4px; padding: 3px; }
.embedded-browser-start-list { display: grid; gap: 6px; }
.embedded-browser-recent-item { flex-direction: column; gap: 3px; padding: 9px 11px; }
.embedded-browser-recent-item span { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.embedded-browser-recent-item small { overflow: hidden; max-width: 100%; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.embedded-browser-start-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
.embedded-browser-host-notice { position: absolute; z-index: 2; right: 10px; bottom: 10px; max-width: min(420px, calc(100% - 20px)); margin: 0; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-raised); color: var(--text-muted); font-size: 12px; pointer-events: none; }
.embedded-browser-creation-approvals { position: absolute; z-index: 3; top: 10px; right: 10px; display: grid; gap: 8px; width: min(420px, calc(100% - 20px)); }
.embedded-browser-creation-card { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); box-shadow: 0 8px 24px rgb(0 0 0 / 16%); }
.embedded-browser-creation-copy { display: grid; flex: 1; min-width: 0; gap: 3px; }
.embedded-browser-creation-copy strong { font-size: 12px; font-weight: 500; }
.embedded-browser-creation-copy span, .embedded-browser-creation-copy small { overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.embedded-browser-creation-actions { display: flex; flex: none; gap: 4px; }
.embedded-browser-creation-error { margin: 0; padding: 8px 10px; border: 1px solid var(--status-danger); border-radius: 6px; background: var(--surface-raised); color: var(--status-danger); font-size: 12px; }
.embedded-browser-pinned-form { display: grid; gap: 8px; }
.embedded-browser-pinned-form > label { color: var(--text-muted); font-size: 12px; font-weight: 500; }
.embedded-browser-pinned-error { margin: 0; color: var(--status-danger); font-size: 12px; }
.embedded-browser[data-state="preparing"] .embedded-browser-state > svg { color: var(--brand-accent); animation: embedded-browser-spin 1s linear infinite; }
@keyframes embedded-browser-spin { to { transform: rotate(360deg); } }
</style>
