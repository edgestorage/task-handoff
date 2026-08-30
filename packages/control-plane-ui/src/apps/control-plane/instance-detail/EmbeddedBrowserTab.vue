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
    </div>
    <div class="embedded-browser-surface">
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
        <span>{{ state === "preparing" ? t("sessions.browser.connecting") : error }}</span>
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
import { ArrowLeft, ArrowRight, CircleAlert, Globe2, History, LoaderCircle, Pin, Plus, RotateCw, X } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { canRenewDesktopBrowserContext, logDesktopBrowserDiagnostic, onDesktopBrowserFocusAddress, prepareDesktopBrowserContext, releaseDesktopBrowserContext, setDesktopBrowserTabThrottled, touchDesktopBrowserContext } from "../../../lib/desktopBridge";
import { browserAddressSuggestions, normalizeDesktopBrowserUrl, sanitizeBrowserStartPageData, type BrowserAddressSuggestion, type PinnedBrowserShortcut, type RecentBrowserPage } from "./browserAddressSuggestions";

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

const props = defineProps<{ instanceId: string; sessionKey?: string; initialUrl?: string; backgroundThrottled?: boolean }>();
const emit = defineEmits<{
  updateTab: [patch: { title?: string; url?: string; status?: string }];
}>();
const { t } = useI18n();
const guest = ref<GuestWebView>();
const addressAnchor = ref<HTMLFormElement>();
const addressInput = ref<HTMLInputElement>();
const context = ref<{ contextId: string; partition: string }>();
const address = ref("");
const error = ref("");
const state = ref<"preparing" | "ready" | "error">("preparing");
const loading = ref(false);
const pinned = ref<PinnedBrowserShortcut[]>([]);
const recent = ref<RecentBrowserPage[]>([]);
const suggestionsOpen = ref(false);
const activeSuggestionIndex = ref(-1);
const suggestionsListId = `embedded-browser-suggestions-${crypto.randomUUID()}`;
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
function resetGuestReady() {
  guestDomReady = false;
  guestDomReadyPromise = new Promise<void>((resolve) => { resolveGuestDomReady = resolve; });
}
resetGuestReady();

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
    emit("updateTab", { status: "running" });
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
  removeGuestListeners?.();
  removeGuestListeners = undefined;
  resetGuestReady();
  const oldContextId = context.value?.contextId;
  context.value = undefined;
  await nextTick();
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
  stopBrowserFocusAddress = onDesktopBrowserFocusAddress(({ webContentsId }) => {
    if (guest.value?.getWebContentsId?.() !== webContentsId) return;
    focusAddress();
  });
  logDesktopBrowserDiagnostic(`browser tab mounted sessionKey=${props.sessionKey || ""}`, props.instanceId);
  await establishContext();
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
      emit("updateTab", { url: "about:blank" });
    }
    if (url && url !== "about:blank") {
      suppressBlankNavigation = false;
      showStartPage.value = false;
      address.value = url;
      emit("updateTab", { url });
      logDesktopBrowserDiagnostic(`browser sync url=${url.slice(0, 160)}`, props.instanceId);
    }
    canGoBack.value = view.canGoBack();
    canGoForward.value = view.canGoForward();
  };
  const start = () => { loading.value = true; emit("updateTab", { status: "loading" }); };
  const finishLoading = () => {
    loading.value = false;
    sync();
    const url = view.getURL();
    const title = view.getTitle?.()?.trim();
    if (url && url !== "about:blank") addRecent(url, title || url);
    logDesktopBrowserDiagnostic(`browser finish title=${(title || "").slice(0, 160)}`, props.instanceId);
    emit("updateTab", { status: "running", ...(title ? { title } : {}) });
  };
  const stopLoading = () => { finishLoading(); };
  const titleUpdated = (event: Event & { title?: string }) => {
    const title = typeof event.title === "string" ? event.title.trim() : "";
    logDesktopBrowserDiagnostic(`browser title event title=${title.slice(0, 160)}`, props.instanceId);
    if (title) emit("updateTab", { title, status: "running" });
  };
  const failed = (event: Event & { errorDescription?: string; validatedURL?: string }) => {
    if (event.validatedURL === "about:blank") return;
    loading.value = false;
    emit("updateTab", { status: "failed" });
    error.value = event.errorDescription || t("sessions.browser.loadFailed");
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
    error.value = "";
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
    logDesktopBrowserDiagnostic(`browser navigation failed url=${url.slice(0, 200)} error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
    error.value = t("sessions.browser.loadFailed");
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
    pinned.value = [...pinned.value, { id: crypto.randomUUID(), name: name.slice(0, 40), url: normalizeDesktopBrowserUrl(value) }].slice(0, 6);
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

function goBack() { guest.value?.goBack(); }
function goForward() { guest.value?.goForward(); }
function reload() { guest.value?.reload(); }
function stop() { guest.value?.stop(); }
</script>

<style scoped>
.embedded-browser { display: grid; width: 100%; height: 100%; grid-template-rows: 40px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; pointer-events: auto; background: var(--surface); }
.embedded-browser-toolbar { display: flex; align-items: center; gap: 2px; min-width: 0; border-bottom: 1px solid var(--line); padding: 4px 6px; }
.embedded-browser-toolbar button { width: 30px; height: 30px; flex: 0 0 30px; }
.embedded-browser-address { display: flex; min-width: 0; height: 30px; flex: 1; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); padding: 0 9px; color: var(--text-muted); }
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
.embedded-browser-state svg { color: var(--status-danger); }
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
.embedded-browser-pinned-form { display: grid; gap: 8px; }
.embedded-browser-pinned-form > label { color: var(--text-muted); font-size: 12px; font-weight: 500; }
.embedded-browser-pinned-error { margin: 0; color: var(--status-danger); font-size: 12px; }
.embedded-browser[data-state="preparing"] .embedded-browser-state svg { color: var(--brand-accent); animation: embedded-browser-spin 1s linear infinite; }
@keyframes embedded-browser-spin { to { transform: rotate(360deg); } }
</style>
