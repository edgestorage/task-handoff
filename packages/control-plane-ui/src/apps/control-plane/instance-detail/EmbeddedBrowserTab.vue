<template>
  <div class="embedded-browser" :class="{ 'start-page-active': showStartPage, 'capture-active': captureActive }" :data-state="state">
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
                <Globe2 v-if="suggestion.kind === 'typed'" :size="14" />
                <Pin v-else-if="suggestion.kind === 'pinned'" :size="14" />
                <History v-else :size="14" />
                <span class="embedded-browser-suggestion-copy"><span>{{ suggestion.title }}</span><small>{{ suggestion.url }}</small></span>
              </button>
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      <Popover :open="pagesOpen" @update:open="pagesOpen = $event">
        <PopoverAnchor as-child>
          <Button
            variant="ghost"
            size="icon"
            class="embedded-browser-pages"
            :class="{ 'embedded-browser-pages-active': pagesOpen }"
            :title="t('sessions.browser.allPages')"
            :aria-label="t('sessions.browser.allPages')"
            @click="pagesOpen = !pagesOpen"
          >
            <Layers :size="15" />
            <span v-if="openPages.length" class="embedded-browser-pages-count" aria-hidden="true">{{ openPages.length }}</span>
          </Button>
        </PopoverAnchor>
        <PopoverContent class="embedded-browser-pages-menu p-0" align="end" side="bottom" :side-offset="6" :collision-padding="10">
          <div v-if="creationPanels.length && !creationContextUnsupported" class="embedded-browser-pages-context">
            <div class="embedded-browser-pages-menu-head">
              <strong>{{ t("sessions.browser.browserContexts") }}</strong>
              <span>{{ creationPanels.length }}</span>
            </div>
            <div class="embedded-browser-context-compact-list">
              <div v-for="panel in creationPanels" :key="`pages-context:${panel.sourceRef}`" class="embedded-browser-context-compact">
                <span class="embedded-browser-context-dot" :class="{ default: panel.isDefault }" aria-hidden="true" />
                <span class="embedded-browser-page-copy">
                  <span>{{ panel.panelLabel }}</span>
                  <small>{{ panel.hostLabel || panel.panelLabel }} · {{ pageHostLabel(panel.pageHost) }}</small>
                </span>
                <span v-if="panel.isDefault" class="embedded-browser-context-badge">{{ t("sessions.browser.creationContextDefault") }}</span>
                <span v-if="panel.isDefault && !panel.canCreate" class="embedded-browser-context-badge offline">{{ t("sessions.browser.creationContextCannotCreate") }}</span>
              </div>
            </div>
          </div>
          <section class="embedded-browser-pages-section">
            <div class="embedded-browser-pages-menu-head">
              <strong>{{ t("sessions.browser.openPages") }}</strong>
              <span>{{ openPages.length }}</span>
            </div>
            <ScrollArea class="embedded-browser-pages-scroll" :horizontal="false">
              <div class="embedded-browser-pages-list">
                <button
                  v-for="page in openPages"
                  :key="page.key"
                  type="button"
                  class="embedded-browser-page-row"
                  :class="{ active: page.key === currentPageKey }"
                  :aria-current="page.key === currentPageKey ? 'page' : undefined"
                  @click="activatePage(page.key)"
                >
                  <Globe2 :size="14" />
                  <span class="embedded-browser-page-copy"><span>{{ pageTitle(page) }}</span><small>{{ pageAddress(page) }}</small></span>
                  <span v-if="page.key === currentPageKey" class="embedded-browser-page-current">{{ t("sessions.browser.currentPage") }}</span>
                </button>
              </div>
            </ScrollArea>
          </section>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        class="embedded-browser-device-toggle"
        :class="{ 'embedded-browser-device-toggle-active': deviceMode }"
        :disabled="deviceControlBusy || !browserTabReady"
        :title="t(deviceMode ? 'sessions.browser.exitDeviceMode' : 'sessions.browser.deviceMode')"
        :aria-label="t(deviceMode ? 'sessions.browser.exitDeviceMode' : 'sessions.browser.deviceMode')"
        :aria-pressed="deviceMode"
        @click="toggleDeviceMode"
      >
        <MonitorSmartphone :size="15" />
      </Button>
      <Popover :open="agentAccessOpen" @update:open="handleAgentAccessOpenChange">
        <PopoverTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="embedded-browser-agent-access"
            :class="{ 'embedded-browser-agent-access-active': browserControlAccess.active }"
            :title="agentAccessTitle"
            :aria-label="agentAccessTitle"
          >
            <Bot :size="15" />
          </Button>
        </PopoverTrigger>
        <PopoverContent class="embedded-browser-agent-access-menu p-0" align="end" side="bottom" :side-offset="6" :collision-padding="10" :aria-label="agentAccessTitle">
          <div class="embedded-browser-agent-access-summary">
            <div class="embedded-browser-agent-access-head">
              <strong><Bot :size="15" aria-hidden="true" />{{ agentAccessTitle }}</strong>
              <Badge variant="outline" class="embedded-browser-agent-access-state" :data-active="browserControlAccess.active">
                <span class="embedded-browser-agent-access-state-dot" aria-hidden="true" />
                {{ t(browserControlAccess.active ? "sessions.browser.agentAccessActive" : "sessions.browser.agentAccessInactive") }}
              </Badge>
            </div>
            <p>{{ agentAccessHint }}</p>
            <Button
              size="sm"
              class="embedded-browser-agent-access-action"
              :variant="browserControlAccess.active ? 'outline' : 'default'"
              :disabled="agentAccessBusy || agentAccessLoading"
              @click="browserControlAccess.active ? revokeBrowserControlAccessForInstance() : grantBrowserControlAccessForInstance()"
            >
              {{ t(browserControlAccess.active ? "sessions.browser.agentAccessRevoke" : "sessions.browser.agentAccessGrant") }}
            </Button>
          </div>
          <section v-if="!creationContextUnsupported" class="embedded-browser-creation-context">
            <div class="embedded-browser-creation-context-head">
              <strong class="embedded-browser-creation-context-title">{{ t("sessions.browser.creationContextLabel") }}</strong>
              <div class="embedded-browser-creation-context-value">
                <strong v-if="hasDefaultCreationContext">{{ defaultCreationLabel }}</strong>
                <span v-else>{{ t("sessions.browser.creationContextNoDefault") }}</span>
                <span v-if="defaultCreationOffline" class="embedded-browser-context-badge offline">{{ t("sessions.browser.creationContextCannotCreate") }}</span>
              </div>
            </div>
            <p v-if="creationContextNotice" class="embedded-browser-creation-context-notice" role="status">{{ creationContextNotice }}</p>
            <p v-if="creationContextError" class="embedded-browser-creation-context-error" role="alert">
              {{ creationContextError }}
              <Button size="sm" variant="link" class="embedded-browser-creation-context-retry" @click="refreshBrowserCreationContext">{{ t("sessions.browser.retry") }}</Button>
            </p>
            <p v-else-if="creationContextLoading && !creationContext" class="embedded-browser-creation-context-empty">{{ t("sessions.browser.creationContextLoading") }}</p>
            <ScrollArea v-else-if="creationPanels.length" class="embedded-browser-creation-panel-scroll" :horizontal="false">
              <TooltipProvider :delay-duration="250">
                <ul class="embedded-browser-creation-panel-list" role="list" :aria-label="t('sessions.browser.creationContextLabel')">
                  <li v-for="panel in creationPanels" :key="panel.sourceRef" class="embedded-browser-creation-panel" :data-default="panel.isDefault">
                    <Monitor class="embedded-browser-creation-panel-icon" :size="15" aria-hidden="true" />
                    <div class="embedded-browser-creation-panel-copy">
                      <span class="embedded-browser-creation-panel-name" :title="panel.panelLabel">{{ panel.panelLabel }}</span>
                      <span class="embedded-browser-creation-panel-meta" :title="creationPanelMeta(panel)">{{ creationPanelMeta(panel) }}</span>
                    </div>
                    <div class="embedded-browser-creation-panel-trailing">
                      <Badge v-if="panel.isDefault" variant="outline" class="embedded-browser-context-badge default border-transparent">{{ t("sessions.browser.creationContextDefault") }}</Badge>
                      <Tooltip v-if="canClaimCreationPanel(panel)">
                        <TooltipTrigger as-child>
                          <Button
                            size="sm"
                            variant="ghost"
                            class="embedded-browser-creation-panel-action"
                            :disabled="creationContextBusy"
                            @click="claimCreationContextForPanel(panel)"
                          >
                            {{ t(hasDefaultCreationContext ? "sessions.browserDefaultActions.takeOver" : "sessions.browserDefaultActions.set") }}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" :collision-padding="10" class="max-w-56">
                          {{ claimCreationLabel }}
                          <div v-if="!hasDefaultCreationContext" class="mt-1 text-muted-foreground">{{ t("sessions.browser.creationContextClaimHint") }}</div>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip v-else-if="canRevokeCreationPanel(panel)">
                        <TooltipTrigger as-child>
                          <Button
                            size="sm"
                            variant="ghost"
                            class="embedded-browser-creation-panel-action"
                            :disabled="creationContextBusy"
                            @click="revokeCreationContextForOwnPanel(panel)"
                          >
                            {{ t("sessions.browserDefaultActions.clear") }}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" :collision-padding="10">{{ t("sessions.browser.creationContextRevoke") }}</TooltipContent>
                      </Tooltip>
                    </div>
                  </li>
                </ul>
              </TooltipProvider>
            </ScrollArea>
            <p v-else class="embedded-browser-creation-context-empty">{{ t("sessions.browser.creationContextNoPanels") }}</p>
            <div v-if="creationContext?.pendingCreation" class="embedded-browser-creation-pending">
              <span>{{ t("sessions.browser.creationContextPending") }}</span>
              <small :title="creationContext.pendingCreation.url">{{ creationContext.pendingCreation.url }}</small>
            </div>
            <p v-if="!browserSourceRef" class="embedded-browser-creation-context-hint">
              {{ t("sessions.browser.creationContextWebReadOnly") }}
            </p>
          </section>
        </PopoverContent>
      </Popover>
    </div>
    <div class="embedded-browser-surface" :class="{ 'device-mode': deviceMode }">
      <p v-if="pageHostNotice" class="embedded-browser-host-notice" role="status">{{ pageHostNotice }}</p>
      <div v-if="deviceMode" class="embedded-browser-device-toolbar">
        <MonitorSmartphone :size="15" aria-hidden="true" />
        <ControlPlaneSelect
          :model-value="selectedDevicePresetId"
          trigger-class="embedded-browser-device-select"
          :aria-label="t('sessions.browser.devicePreset')"
          @update:model-value="selectDevicePreset"
        >
          <ControlPlaneSelectItem v-for="preset in BROWSER_DEVICE_PRESETS" :key="preset.id" :value="preset.id">{{ t(preset.labelKey) }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem :value="CUSTOM_BROWSER_DEVICE_ID">{{ t("sessions.browser.customDevice") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <label class="embedded-browser-device-field">
          <span>{{ t("sessions.browser.deviceWidth") }}</span>
          <input
            type="number"
            inputmode="numeric"
            min="1"
            :max="BROWSER_DEVICE_MAX_DIMENSION"
            :value="deviceMetrics.width"
            :aria-label="t('sessions.browser.deviceWidth')"
            @change="commitDeviceDimension('width', $event)"
          />
        </label>
        <span class="embedded-browser-device-times" aria-hidden="true">×</span>
        <label class="embedded-browser-device-field">
          <span>{{ t("sessions.browser.deviceHeight") }}</span>
          <input
            type="number"
            inputmode="numeric"
            min="1"
            :max="BROWSER_DEVICE_MAX_DIMENSION"
            :value="deviceMetrics.height"
            :aria-label="t('sessions.browser.deviceHeight')"
            @change="commitDeviceDimension('height', $event)"
          />
        </label>
        <ControlPlaneSelect
          :model-value="selectedDeviceZoomId"
          trigger-class="embedded-browser-device-zoom-select"
          :aria-label="t('sessions.browser.deviceZoom')"
          @update:model-value="selectDeviceZoom"
        >
          <ControlPlaneSelectItem :value="BROWSER_DEVICE_ZOOM_FIT">{{ t("sessions.browser.deviceZoomFit") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="percentage in BROWSER_DEVICE_ZOOM_PERCENTAGES" :key="percentage" :value="String(percentage)">{{ percentage }}%</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <Button variant="ghost" size="icon" :disabled="deviceControlBusy" :title="t('sessions.browser.rotateDevice')" :aria-label="t('sessions.browser.rotateDevice')" @click="rotateDevice">
          <RotateCcw :size="15" />
        </Button>
        <Button variant="ghost" size="icon" :disabled="deviceControlBusy" :title="t('sessions.browser.exitDeviceMode')" :aria-label="t('sessions.browser.exitDeviceMode')" @click="exitDeviceMode">
          <X :size="15" />
        </Button>
      </div>
      <div ref="deviceStage" class="embedded-browser-device-stage">
        <div class="embedded-browser-device-scaler" :style="deviceScalerStyle">
          <div class="embedded-browser-device-frame" :style="deviceFrameStyle">
            <webview
              v-if="context?.partition"
              ref="guest"
              src="about:blank"
              :partition="context.partition"
              allowpopups
              @did-attach="scheduleGuestRegistration('did-attach')"
              @dom-ready="handleGuestDomReady"
            />
            <div v-if="showStartPage" class="embedded-browser-start-page">
        <section v-if="openPages.length" class="embedded-browser-start-section">
          <div class="embedded-browser-start-heading"><h2>{{ t("sessions.browser.openPages") }}</h2><span class="embedded-browser-start-count">{{ openPages.length }}</span></div>
          <div class="embedded-browser-start-list">
            <button
              v-for="page in openPages"
              :key="`start:${page.key}`"
              type="button"
              class="embedded-browser-recent-item embedded-browser-open-page-row"
              :class="{ active: page.key === currentPageKey }"
              @click="activatePage(page.key)"
            >
              <span>{{ pageTitle(page) }}<em v-if="page.key === currentPageKey" class="embedded-browser-open-page-current">{{ t("sessions.browser.currentPage") }}</em></span>
              <small>{{ pageAddress(page) }}</small>
            </button>
          </div>
        </section>
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, ArrowRight, Bot, CircleAlert, Globe2, History, Layers, LoaderCircle, Monitor, MonitorSmartphone, Pin, Plus, RotateCcw, RotateCw, X } from "@lucide/vue";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import {
  EmbeddedBrowserCreationContextChangedEventSchema,
  type EmbeddedBrowserAccessView,
  type EmbeddedBrowserCreationContextSnapshot,
  type EmbeddedBrowserCreationPanel,
} from "@task-handoff/protocol/embedded-browser-control";
import {
  claimBrowserCreationContext,
  getBrowserControlAccess,
  getBrowserCreationContext,
  grantBrowserControlAccess,
  revokeBrowserControlAccess,
  revokeBrowserCreationContext,
} from "../../../api/browserControl";
import { attachDesktopBrowserTarget, canRenewDesktopBrowserContext, getDesktopBrowserControlInfo, logDesktopBrowserDiagnostic, onDesktopBrowserDeviceMetricsChanged, onDesktopBrowserFocusAddress, onDesktopBrowserLoadFailure, onDesktopBrowserTabClosed, prepareDesktopBrowserContext, registerDesktopBrowserTab, releaseDesktopBrowserContext, sendDesktopBrowserCdpCommand, setDesktopBrowserTabThrottled, touchDesktopBrowserContext, unregisterDesktopBrowserTab, updateDesktopBrowserTab } from "../../../lib/desktopBridge";
import {
  BROWSER_ACCESS_CHANGED_EVENT,
  BROWSER_CREATION_CONTEXT_CHANGED_EVENT,
  type BrowserCreationEventDetail,
} from "./browserCreationEvents";
import { createBrowserUuid } from "../../../lib/random-id";
import { browserFailureTarget, browserLoadFailureKey, isBrowserPageLoadFailure } from "./browserLoadFailure";
import { browserDeviceEmulationParams, browserDevicePreset, browserDevicePresetForMetrics, browserDeviceZoomScale, BROWSER_DEVICE_MAX_DIMENSION, BROWSER_DEVICE_PRESETS, BROWSER_DEVICE_ZOOM_FIT, BROWSER_DEVICE_ZOOM_PERCENTAGES, CUSTOM_BROWSER_DEVICE_ID, DEFAULT_BROWSER_DEVICE_PRESET, normalizeBrowserDeviceDimension, rotateBrowserDeviceMetrics, type BrowserDeviceMetrics } from "./browserDeviceMetrics";
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

export type BrowserOpenPage = { key: string; title?: string; url?: string; status?: string };

const props = defineProps<{ instanceId: string; pageKey?: string; initialUrl?: string; creationRef?: string; backgroundThrottled?: boolean; captureActive?: boolean; openPages?: BrowserOpenPage[] }>();
const emit = defineEmits<{
  updateTab: [patch: { title?: string; url?: string; status?: string }];
  closeTab: [];
  movePage: [pageKey: string];
}>();
const { t } = useI18n();
const guest = ref<GuestWebView>();
const deviceStage = ref<HTMLElement>();
const addressAnchor = ref<HTMLFormElement>();
const addressInput = ref<HTMLInputElement>();
const context = ref<{ contextId: string; partition: string }>();
const address = ref("");
const error = ref("");
const errorDetail = ref("");
const state = ref<"preparing" | "ready" | "error">("preparing");
const browserTabReady = ref(false);
const deviceMode = ref(false);
const deviceControlBusy = ref(false);
const selectedDevicePresetId = ref(DEFAULT_BROWSER_DEVICE_PRESET.id);
const selectedDeviceZoomId = ref<string>(BROWSER_DEVICE_ZOOM_FIT);
const deviceScale = ref(1);
const deviceMetrics = reactive<BrowserDeviceMetrics>({
  width: DEFAULT_BROWSER_DEVICE_PRESET.width,
  height: DEFAULT_BROWSER_DEVICE_PRESET.height,
  deviceScaleFactor: DEFAULT_BROWSER_DEVICE_PRESET.deviceScaleFactor,
  mobile: DEFAULT_BROWSER_DEVICE_PRESET.mobile,
});
const DEVICE_STAGE_PADDING = 24;
const DEVICE_COMMAND_TIMEOUT_MS = 8_000;
let deviceStageResizeObserver: ResizeObserver | undefined;
let removeDeviceMetricsListener: (() => void) | undefined;
let deviceCommandSequence = 0;
const pageHostNotice = ref("");
const browserSourceRef = ref<string>();
const pagesOpen = ref(false);
const agentAccessOpen = ref(false);
const browserControlAccess = ref<EmbeddedBrowserAccessView>({ active: false, revision: 0 });
const agentAccessLoading = ref(false);
const agentAccessBusy = ref(false);
let agentAccessRequestRevision = 0;
const creationContext = ref<EmbeddedBrowserCreationContextSnapshot>();
const creationContextLoading = ref(false);
const creationContextBusy = ref(false);
const creationContextUnsupported = ref(false);
const creationContextError = ref("");
const creationContextNotice = ref("");
let creationContextRequestRevision = 0;
const agentAccessTitle = computed(() => t("sessions.browser.agentAccess"));
const agentAccessHint = computed(() => t(
  browserControlAccess.value.active
    ? "sessions.browser.agentAccessRevokeHint"
    : "sessions.browser.agentAccessGrantHint",
));
const openPages = computed(() => props.openPages || []);
const creationPanels = computed(() => creationContext.value?.panels || []);
const defaultCreationPanel = computed(() => creationPanels.value.find((panel) => panel.isDefault));
const defaultCreationLabel = computed(() => defaultCreationPanel.value?.panelLabel || creationContext.value?.defaultContext?.sourceRef || "");
const hasDefaultCreationContext = computed(() => Boolean(creationContext.value?.defaultContext));
const claimCreationLabel = computed(() => t(hasDefaultCreationContext.value
  ? "sessions.browser.creationContextTakeOver"
  : "sessions.browser.creationContextRequestDefault"));
const defaultCreationOffline = computed(() => Boolean(creationContext.value?.defaultContext)
  && (!defaultCreationPanel.value || !defaultCreationPanel.value.canCreate));
const currentPageKey = computed(() => props.pageKey || "");
const loading = ref(false);
const pinned = ref<PinnedBrowserShortcut[]>([]);
const recent = ref<RecentBrowserPage[]>([]);
const suggestionsOpen = ref(false);
const activeSuggestionIndex = ref(-1);
const suggestionsListId = `embedded-browser-suggestions-${createBrowserUuid()}`;
const localSessionKey = props.pageKey?.trim() || `embedded-browser:${createBrowserUuid()}`;
const suggestions = computed(() => browserAddressSuggestions(pinned.value, recent.value, address.value));
const activeSuggestionId = computed(() => activeSuggestionIndex.value >= 0 ? suggestionOptionId(activeSuggestionIndex.value) : undefined);
const deviceScalerStyle = computed(() => deviceMode.value
  ? {
      width: `${deviceMetrics.width * deviceScale.value}px`,
      height: `${deviceMetrics.height * deviceScale.value}px`,
    }
  : { width: "100%", height: "100%" });
const deviceFrameStyle = computed<CSSProperties>(() => deviceMode.value
  ? {
      boxSizing: "content-box",
      width: `${deviceMetrics.width}px`,
      height: `${deviceMetrics.height}px`,
      transform: `scale(${deviceScale.value})`,
      transformOrigin: "top left",
    }
  : { boxSizing: "border-box", width: "100%", height: "100%" });
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
let removeAccessChangedListener: (() => void) | undefined;
let removeCreationContextChangedListener: (() => void) | undefined;
let lastChromiumError: { code?: number; description?: string } | undefined;
let tunnelFailure: { host?: string; port?: number; code?: string; message?: string } | undefined;
let lastFailureUrl = "";
let registeredTabRef: string | undefined;
let registeringTab = false;
let guestRegistrationRetryTimer: number | undefined;
let guestRegistrationAttempts = 0;
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

function resolveGuestWebContentsId() {
  try {
    const webContentsId = guest.value?.getWebContentsId?.();
    return Number.isInteger(webContentsId) ? webContentsId : undefined;
  } catch (cause) {
    logDesktopBrowserDiagnostic(`browser webview id unavailable error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
    return undefined;
  }
}

function scheduleGuestRegistration(reason: string) {
  if (disposed || registeredTabRef || registeringTab || guestRegistrationRetryTimer !== undefined) return;
  const attempt = () => {
    guestRegistrationRetryTimer = undefined;
    if (disposed || registeredTabRef || registeringTab) return;
    const webContentsId = resolveGuestWebContentsId();
    if (webContentsId === undefined) {
      guestRegistrationAttempts += 1;
      if (guestRegistrationAttempts <= 20) {
        logDesktopBrowserDiagnostic(`browser tab registration waiting for webContentsId attempt=${guestRegistrationAttempts} reason=${reason}`, props.instanceId);
        guestRegistrationRetryTimer = window.setTimeout(attempt, 100);
      } else {
        logDesktopBrowserDiagnostic(`browser tab registration skipped webContentsId unavailable reason=${reason}`, props.instanceId);
      }
      return;
    }
    void registerGuestTab(webContentsId);
  };
  attempt();
}

async function registerGuestTab(webContentsId: number) {
  const view = guest.value;
  if (!Number.isInteger(webContentsId) || disposed || registeredTabRef || registeringTab) return;
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
      if (result.code === "BROWSER_GUEST_NOT_FOUND" && guestRegistrationAttempts < 20) {
        guestRegistrationAttempts += 1;
        guestRegistrationRetryTimer = window.setTimeout(() => {
          guestRegistrationRetryTimer = undefined;
          scheduleGuestRegistration("guest-not-found");
        }, 100);
      }
      return;
    }
    guestRegistrationAttempts = 0;
    registeredTabRef = result.tab.tabRef;
    browserTabReady.value = true;
    logDesktopBrowserDiagnostic(`browser tab registered tabRef=${registeredTabRef} pageHost=${result.tab.pageHost}`, props.instanceId);
    if (deviceMode.value) void applyDeviceMetrics();
  } catch (cause) {
    logDesktopBrowserDiagnostic(`browser tab registration failed error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
  } finally {
    registeringTab = false;
  }
}

function unregisterGuestTab() {
  const webContentsId = guest.value?.getWebContentsId?.();
  registeredTabRef = undefined;
  browserTabReady.value = false;
  if (guestRegistrationRetryTimer !== undefined) {
    window.clearTimeout(guestRegistrationRetryTimer);
    guestRegistrationRetryTimer = undefined;
  }
  if (Number.isInteger(webContentsId)) void unregisterDesktopBrowserTab(webContentsId!).catch(() => undefined);
}

function updateDeviceScale() {
  if (!deviceMode.value || !deviceStage.value) {
    deviceScale.value = 1;
    return;
  }
  const fixedScale = browserDeviceZoomScale(selectedDeviceZoomId.value);
  if (fixedScale !== undefined) {
    deviceScale.value = fixedScale;
    return;
  }
  const availableWidth = deviceStage.value.clientWidth - DEVICE_STAGE_PADDING * 2;
  const availableHeight = deviceStage.value.clientHeight - DEVICE_STAGE_PADDING * 2;
  const frameWidth = deviceMetrics.width;
  const frameHeight = deviceMetrics.height;
  if (availableWidth <= 0 || availableHeight <= 0) {
    deviceScale.value = 1;
    return;
  }
  deviceScale.value = Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight);
}

function selectDeviceZoom(value: string) {
  if (value !== BROWSER_DEVICE_ZOOM_FIT && browserDeviceZoomScale(value) === undefined) return;
  selectedDeviceZoomId.value = value;
  updateDeviceScale();
}

async function sendDeviceCdp(method: string, params?: unknown) {
  const tabRef = registeredTabRef;
  if (!tabRef) return false;
  const attached = await attachDesktopBrowserTarget(tabRef);
  if (!attached.ok) {
    const message = "message" in attached && attached.message ? attached.message : attached.code || "Browser target attach failed.";
    throw Object.assign(new Error(message), { code: attached.code });
  }
  const result = await sendDesktopBrowserCdpCommand({ tabRef, method, ...(params === undefined ? {} : { params }) });
  if (!result.ok) {
    const message = "message" in result && result.message ? result.message : result.code || "Browser device command failed.";
    throw Object.assign(new Error(message), { code: result.code });
  }
  return true;
}

async function runDeviceCommand(method: string, params?: unknown) {
  if (!registeredTabRef) return false;
  const sequence = ++deviceCommandSequence;
  deviceControlBusy.value = true;
  let timeout: number | undefined;
  try {
    await Promise.race([
      sendDeviceCdp(method, params),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(`Browser device command timed out: ${method}`)), DEVICE_COMMAND_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (cause) {
    if (sequence === deviceCommandSequence) {
      logDesktopBrowserDiagnostic(`browser device command failed method=${method} error=${cause instanceof Error ? cause.message : String(cause)}`, props.instanceId);
      showControlPlaneToast(t("sessions.browser.deviceApplyFailed"), "error");
    }
    return false;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (sequence === deviceCommandSequence) deviceControlBusy.value = false;
  }
}

async function applyDeviceMetrics() {
  return runDeviceCommand("Emulation.setDeviceMetricsOverride", browserDeviceEmulationParams(deviceMetrics));
}

function syncSelectedDevicePreset() {
  selectedDevicePresetId.value = browserDevicePresetForMetrics(deviceMetrics)?.id || CUSTOM_BROWSER_DEVICE_ID;
}

async function toggleDeviceMode() {
  if (deviceControlBusy.value) return;
  if (deviceMode.value) {
    await exitDeviceMode();
    return;
  }
  if (!browserTabReady.value) {
    showControlPlaneToast(t("sessions.browser.deviceApplyFailed"), "error");
    return;
  }
  deviceMode.value = true;
  await nextTick();
  updateDeviceScale();
  if (!(await applyDeviceMetrics())) deviceMode.value = false;
}

async function exitDeviceMode() {
  if (!deviceMode.value || deviceControlBusy.value) return;
  if (!registeredTabRef) {
    deviceMode.value = false;
    return;
  }
  if (await runDeviceCommand("Emulation.clearDeviceMetricsOverride")) {
    deviceMode.value = false;
    logDesktopBrowserDiagnostic("browser device mode cleared", props.instanceId);
  }
}

async function selectDevicePreset(id: string) {
  if (!id || deviceControlBusy.value) return;
  if (id === CUSTOM_BROWSER_DEVICE_ID) {
    selectedDevicePresetId.value = id;
    return;
  }
  const preset = browserDevicePreset(id);
  if (!preset) return;
  selectedDevicePresetId.value = id;
  Object.assign(deviceMetrics, {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile,
  });
  await applyDeviceMetrics();
}

async function commitDeviceDimension(axis: "width" | "height", event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const value = normalizeBrowserDeviceDimension(input.value);
  if (!value) {
    input.value = String(deviceMetrics[axis]);
    return;
  }
  if (value === deviceMetrics[axis]) return;
  deviceMetrics[axis] = value;
  syncSelectedDevicePreset();
  await applyDeviceMetrics();
}

async function rotateDevice() {
  if (deviceControlBusy.value) return;
  Object.assign(deviceMetrics, rotateBrowserDeviceMetrics(deviceMetrics));
  syncSelectedDevicePreset();
  await applyDeviceMetrics();
}

function handleDeviceMetricsChanged(input: { tabRef?: string; instanceId?: string; source?: string; active?: boolean; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean }) {
  if (input.instanceId !== props.instanceId || input.tabRef !== registeredTabRef || input.source !== "agent") return;
  if (!input.active) {
    deviceMode.value = false;
    logDesktopBrowserDiagnostic("browser device mode cleared by agent", props.instanceId);
    return;
  }
  const width = normalizeBrowserDeviceDimension(input.width);
  const height = normalizeBrowserDeviceDimension(input.height);
  if (!width || !height) return;
  deviceMetrics.width = width;
  deviceMetrics.height = height;
  deviceMetrics.deviceScaleFactor = typeof input.deviceScaleFactor === "number" && Number.isFinite(input.deviceScaleFactor) && input.deviceScaleFactor > 0
    ? Math.min(input.deviceScaleFactor, 10)
    : 1;
  deviceMetrics.mobile = input.mobile === true;
  syncSelectedDevicePreset();
  deviceMode.value = true;
  void nextTick(updateDeviceScale);
  logDesktopBrowserDiagnostic(`browser device mode mirrored from agent width=${width} height=${height} mobile=${deviceMetrics.mobile}`, props.instanceId);
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

function pageTitle(page: BrowserOpenPage) {
  return page.title?.trim() || pageAddress(page);
}

function pageAddress(page: BrowserOpenPage) {
  return page.url?.trim() || t("sessions.browser.newTab");
}

function activatePage(pageKey: string) {
  pagesOpen.value = false;
  if (!pageKey) return;
  if (pageKey === currentPageKey.value) {
    logDesktopBrowserDiagnostic("browser page activate ignored current", props.instanceId);
    return;
  }
  logDesktopBrowserDiagnostic(`browser page move requested target=${pageKey.slice(0, 160)}`, props.instanceId);
  emit("movePage", pageKey);
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
  removeDeviceMetricsListener = onDesktopBrowserDeviceMetricsChanged((input) => handleDeviceMetricsChanged(input));
  if (deviceStage.value && typeof ResizeObserver !== "undefined") {
    deviceStageResizeObserver = new ResizeObserver(() => updateDeviceScale());
    deviceStageResizeObserver.observe(deviceStage.value);
  }
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
  const handleAccessChanged = (event: Event) => {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (detail?.instanceId && detail.instanceId !== props.instanceId) return;
    void refreshBrowserControlAccess();
  };
  window.addEventListener(BROWSER_ACCESS_CHANGED_EVENT, handleAccessChanged);
  removeAccessChangedListener = () => window.removeEventListener(BROWSER_ACCESS_CHANGED_EVENT, handleAccessChanged);
  const handleCreationContextChanged = (event: Event) => {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (detail?.instanceId && detail.instanceId !== props.instanceId) return;
    creationContextNotice.value = "";
    const payload = detail?.payload;
    const changed = EmbeddedBrowserCreationContextChangedEventSchema.safeParse(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, type: "browser.creation-context.changed" }
        : payload,
    );
    const ownDefaultWasTakenOver = Boolean(
      changed.success
      && browserSourceRef.value
      && changed.data.previousBrowserContextId === browserSourceRef.value
      && Boolean(changed.data.defaultBrowserContextId)
      && changed.data.defaultBrowserContextId !== browserSourceRef.value,
    );
    void refreshBrowserCreationContext().then(() => {
      if (!ownDefaultWasTakenOver || disposed) return;
      const nextLabel = defaultCreationLabel.value
        || (changed.success ? changed.data.defaultBrowserContextId : "")
        || t("sessions.browser.creationContextNoDefault");
      creationContextNotice.value = t("sessions.browser.creationContextTakenOver", {
        panel: nextLabel,
      });
    });
  };
  window.addEventListener(BROWSER_CREATION_CONTEXT_CHANGED_EVENT, handleCreationContextChanged);
  removeCreationContextChangedListener = () => window.removeEventListener(BROWSER_CREATION_CONTEXT_CHANGED_EVENT, handleCreationContextChanged);
  logDesktopBrowserDiagnostic(`browser tab mounted pageKey=${props.pageKey || ""}`, props.instanceId);
  await establishContext();
  await loadPageHostDiagnostic();
  await Promise.all([refreshBrowserControlAccess(), refreshBrowserCreationContext()]);
});

watch(() => [context.value?.partition, showStartPage.value] as const, async ([partition, startPage]) => {
  if (!partition) return;
  if (startPage || !pendingNavigation.value) return;
  await dispatchPendingNavigation(navigationSequence);
});

watch(() => [deviceMode.value, deviceMetrics.width, deviceMetrics.height] as const, async () => {
  await nextTick();
  updateDeviceScale();
});

onBeforeUnmount(() => {
  disposed = true;
  logDesktopBrowserDiagnostic(`browser tab unmounted pageKey=${props.pageKey || ""} contextId=${context.value?.contextId || ""}`, props.instanceId);
  stopContextHeartbeat();
  deviceStageResizeObserver?.disconnect();
  deviceStageResizeObserver = undefined;
  removeDeviceMetricsListener?.();
  stopBrowserFocusAddress?.();
  removeLoadFailureListener?.();
  removeTabClosedListener?.();
  removeAccessChangedListener?.();
  removeCreationContextChangedListener?.();
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
    if (!registeredTabRef) scheduleGuestRegistration("did-finish-load");
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
  const failed = (event: Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }) => {
    if (!isBrowserPageLoadFailure(event)) return;
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
  scheduleGuestRegistration("dom-ready");
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
    address.value = url;
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
  if (open) void Promise.all([refreshBrowserControlAccess(), refreshBrowserCreationContext()]);
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
    await refreshBrowserCreationContext();
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
    await refreshBrowserCreationContext();
    showControlPlaneToast(t("sessions.browser.agentAccessRevoked"), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.browser.agentAccessFailed")), "error");
  } finally {
    agentAccessBusy.value = false;
  }
}

function pageHostLabel(pageHost: EmbeddedBrowserCreationPanel["pageHost"]) {
  return pageHost === "main-page-pool"
    ? t("sessions.browser.pageHostMainPool")
    : t("sessions.browser.pageHostRenderer");
}

function isOwnCreationPanel(panel: EmbeddedBrowserCreationPanel) {
  return Boolean(browserSourceRef.value && panel.sourceRef === browserSourceRef.value);
}

function creationPanelMeta(panel: EmbeddedBrowserCreationPanel) {
  return [
    isOwnCreationPanel(panel) && t("sessions.browser.creationContextThisPanel"),
    !panel.canCreate && t("sessions.browser.creationContextCannotCreate"),
    pageHostLabel(panel.pageHost),
    panel.hostLabel !== panel.panelLabel && panel.hostLabel,
  ].filter(Boolean).join(" · ");
}

function canClaimCreationPanel(panel: EmbeddedBrowserCreationPanel) {
  return isOwnCreationPanel(panel) && panel.canClaim && panel.canCreate && !panel.isDefault;
}

function canRevokeCreationPanel(panel: EmbeddedBrowserCreationPanel) {
  return isOwnCreationPanel(panel) && panel.isDefault;
}

function apiErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

async function refreshBrowserCreationContext() {
  const revision = ++creationContextRequestRevision;
  creationContextLoading.value = true;
  try {
    const snapshot = await getBrowserCreationContext(props.instanceId, browserSourceRef.value);
    if (revision !== creationContextRequestRevision) return;
    creationContext.value = snapshot;
    creationContextUnsupported.value = false;
    creationContextError.value = "";
  } catch (cause) {
    if (revision !== creationContextRequestRevision) return;
    const code = apiErrorCode(cause);
    if (code === "BROWSER_OPERATION_UNSUPPORTED" || code === "BROWSER_CHANNEL_UNSUPPORTED") {
      creationContext.value = undefined;
      creationContextUnsupported.value = true;
      creationContextError.value = "";
    } else {
      creationContextError.value = translateApiError(cause, t, t("sessions.browser.creationContextLoadFailed"));
    }
  } finally {
    if (revision === creationContextRequestRevision) creationContextLoading.value = false;
  }
}

async function claimCreationContextForPanel(panel: EmbeddedBrowserCreationPanel) {
  const snapshot = creationContext.value;
  if (creationContextBusy.value || !snapshot || !canClaimCreationPanel(panel)) return;
  creationContextBusy.value = true;
  creationContextError.value = "";
  try {
    await claimBrowserCreationContext(props.instanceId, panel.sourceRef, snapshot.revision);
    creationContextNotice.value = "";
    await refreshBrowserCreationContext();
    // Choosing a default creation panel is the same user decision as allowing
    // Agent browser access: one click grants both, while revocation stays a
    // separate explicit action.
    if (!browserControlAccess.value.active) {
      try {
        browserControlAccess.value = await grantBrowserControlAccess(props.instanceId);
      } catch {
        // The default panel claim already succeeded. Access can still be
        // granted from the same popover without repeating the claim.
      }
    }
    showControlPlaneToast(t("sessions.browser.creationContextClaimed", { panel: panel.panelLabel }), "success");
  } catch (cause) {
    const conflict = apiErrorCode(cause) === "BROWSER_DEFAULT_CONTEXT_CONFLICT";
    showControlPlaneToast(
      conflict
        ? t("sessions.browser.creationContextConflict")
        : translateApiError(cause, t, t("sessions.browser.creationContextClaimFailed")),
      "error",
    );
    await refreshBrowserCreationContext();
  } finally {
    creationContextBusy.value = false;
  }
}

async function revokeCreationContextForOwnPanel(panel: EmbeddedBrowserCreationPanel) {
  const snapshot = creationContext.value;
  if (creationContextBusy.value || !snapshot || !canRevokeCreationPanel(panel)) return;
  creationContextBusy.value = true;
  creationContextError.value = "";
  try {
    await revokeBrowserCreationContext(props.instanceId, panel.sourceRef, snapshot.revision);
    creationContextNotice.value = "";
    await refreshBrowserCreationContext();
    showControlPlaneToast(t("sessions.browser.creationContextRevoked"), "success");
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("sessions.browser.creationContextRevokeFailed")), "error");
    await refreshBrowserCreationContext();
  } finally {
    creationContextBusy.value = false;
  }
}
</script>

<style scoped>
.embedded-browser { display: grid; width: 100%; height: 100%; grid-template-rows: 40px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; pointer-events: auto; background: var(--surface); }
.embedded-browser-toolbar { display: flex; align-items: center; gap: 2px; min-width: 0; border-bottom: 1px solid var(--line); padding: 4px 6px; }
.embedded-browser-toolbar button { width: 30px; height: 30px; flex: 0 0 30px; }
.embedded-browser-address { display: flex; min-width: 0; height: 30px; flex: 1; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); padding: 0 9px; color: var(--text-muted); }
.embedded-browser-pages { position: relative; }
.embedded-browser-pages-active, .embedded-browser-device-toggle-active, .embedded-browser-agent-access-active { color: var(--text); background: var(--surface-hover); }
.embedded-browser-pages-count { position: absolute; top: 1px; right: 0; min-width: 13px; height: 13px; border-radius: 999px; background: var(--brand-accent); color: var(--surface); font-size: 9px; font-weight: 500; line-height: 13px; text-align: center; }
.embedded-browser-pages-menu { display: flex; width: min(360px, var(--reka-popover-content-available-width)); max-height: min(480px, var(--reka-popover-content-available-height)); flex-direction: column; overflow: hidden; }
.embedded-browser-pages-context { display: grid; flex: 0 0 auto; gap: 2px; padding-bottom: 5px; }
.embedded-browser-pages-section { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; border-top: 1px solid var(--line); }
.embedded-browser-pages-menu-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px 6px; color: var(--text-muted); font-size: 12px; }
.embedded-browser-pages-menu-head strong { color: var(--text); font-size: 13px; font-weight: 500; }
.embedded-browser-pages-scroll { min-height: 0; flex: 1 1 auto; }
.embedded-browser-pages-list { display: grid; gap: 2px; padding: 0 5px 5px; }
.embedded-browser-page-row { display: flex; min-height: 46px; align-items: center; width: 100%; min-width: 0; gap: 9px; border: 0; border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; padding: 7px 8px; text-align: left; }
.embedded-browser-page-row:hover, .embedded-browser-page-row.active { background: var(--surface-hover); }
.embedded-browser-page-row > svg { flex: 0 0 auto; color: var(--text-muted); }
.embedded-browser-page-copy { display: grid; min-width: 0; flex: 1; gap: 1px; }
.embedded-browser-page-copy > span, .embedded-browser-page-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.embedded-browser-page-copy > span { font-size: 13px; line-height: 18px; }
.embedded-browser-page-copy > small { color: var(--text-muted); font-size: 12px; line-height: 17px; }
.embedded-browser-page-current { flex: 0 0 auto; border-radius: 999px; background: var(--brand-accent-soft); color: var(--brand-accent); font-size: 11px; padding: 1px 6px; }
.embedded-browser-context-compact-list { display: grid; gap: 2px; padding: 0 5px; }
.embedded-browser-context-compact { display: flex; min-height: 44px; min-width: 0; align-items: center; gap: 9px; border-radius: 6px; padding: 6px 8px; }
.embedded-browser-context-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 999px; background: var(--text-muted); opacity: .45; }
.embedded-browser-context-dot.default { background: var(--brand-accent); opacity: 1; }
.embedded-browser-context-badge { flex: 0 0 auto; border-radius: 999px; background: var(--surface-hover); color: var(--text-muted); font-size: 11px; font-weight: 400; padding: 1px 6px; }
.embedded-browser-context-badge.default { background: var(--brand-accent-soft); color: var(--brand-accent); }
.embedded-browser-context-badge.offline { background: var(--status-danger-bg); color: var(--status-danger); }
:global(.embedded-browser-agent-access-menu) { display: flex; width: min(360px, var(--reka-popover-content-available-width)); max-height: var(--reka-popover-content-available-height); flex-direction: column; overflow: hidden; }
.embedded-browser-agent-access-summary { display: grid; min-width: 0; flex: 0 0 auto; gap: 8px; padding: 12px; }
.embedded-browser-agent-access-head, .embedded-browser-creation-context-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; }
.embedded-browser-agent-access-head strong, .embedded-browser-creation-context-title { color: var(--text-strong); font-size: 12px; font-weight: 500; line-height: 17px; }
.embedded-browser-agent-access-head strong { display: flex; align-items: center; gap: 7px; }
.embedded-browser-agent-access-head svg { flex: none; color: var(--text-muted); }
.embedded-browser-agent-access-summary p, .embedded-browser-creation-context p { margin: 0; overflow-wrap: anywhere; color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 17px; }
.embedded-browser-agent-access-state { border-radius: 6px; border-color: var(--line); padding: 1px 6px; color: var(--text-muted); font-size: 11px; font-weight: 400; line-height: 16px; }
.embedded-browser-agent-access-state[data-active="true"] { border-color: color-mix(in srgb, var(--status-success) 36%, var(--line)); background: var(--status-success-bg); color: var(--status-success); }
.embedded-browser-agent-access-state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.embedded-browser-agent-access-action { height: auto; min-height: 28px; max-width: 100%; justify-self: start; padding: 4px 8px; font-weight: 400; line-height: 16px; white-space: normal; overflow-wrap: anywhere; }
.embedded-browser-creation-context { --creation-context-inline-padding: 12px; display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; gap: 6px; border-top: 1px solid var(--line-subtle); padding: 8px var(--creation-context-inline-padding) 10px; }
.embedded-browser-creation-context > :not(.embedded-browser-creation-panel-scroll) { flex: none; }
.embedded-browser-creation-context-head { color: var(--text-muted); font-size: 12px; line-height: 16px; }
.embedded-browser-creation-context-value { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 4px; overflow-wrap: anywhere; }
.embedded-browser-creation-context-value strong { min-width: 0; color: var(--text); font-weight: 500; }
.embedded-browser-creation-context .embedded-browser-creation-context-notice { border-radius: 6px; background: var(--brand-accent-soft); padding: 6px 8px; color: var(--text); }
.embedded-browser-creation-context .embedded-browser-creation-context-error { color: var(--status-danger); }
.embedded-browser-creation-context-retry { height: auto; padding: 0 2px; font-weight: 400; }
.embedded-browser-creation-context-empty { padding: 4px 0; }
.embedded-browser-creation-panel-scroll { display: flex; min-height: 0; max-height: 224px; flex: 0 1 auto; margin-inline-end: calc(-1 * var(--creation-context-inline-padding)); }
.embedded-browser-creation-panel-scroll :deep([data-task-handoff-scroll-viewport]) { height: auto; min-height: 0; }
.embedded-browser-creation-panel-list { margin: 0; padding: 0; padding-inline-end: var(--creation-context-inline-padding); list-style: none; }
.embedded-browser-creation-panel { display: grid; min-height: 44px; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding-block: 5px; padding-inline-start: 4px; }
.embedded-browser-creation-panel + .embedded-browser-creation-panel { border-top: 1px solid var(--line-subtle); }
.embedded-browser-creation-panel-icon { color: var(--text-muted); }
.embedded-browser-creation-panel[data-default="true"] .embedded-browser-creation-panel-icon { color: var(--brand-accent); }
.embedded-browser-creation-panel-copy { display: grid; min-width: 0; gap: 1px; }
.embedded-browser-creation-panel-name, .embedded-browser-creation-panel-meta { overflow: hidden; font-size: 12px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.embedded-browser-creation-panel-name { color: var(--text-strong); font-weight: 500; }
.embedded-browser-creation-panel-meta { color: var(--text-muted); font-weight: 400; }
.embedded-browser-creation-panel-trailing { display: flex; align-items: center; gap: 4px; }
.embedded-browser-creation-panel-action { height: 28px; padding-inline: 8px; color: var(--text); }
.embedded-browser-creation-pending { display: grid; gap: 2px; border-left: 2px solid var(--line-strong); padding: 2px 0 2px 8px; color: var(--text); font-size: 12px; }
.embedded-browser-creation-pending small { overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
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
.embedded-browser-surface { position: relative; display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; pointer-events: auto; background: #fff; }
.embedded-browser-surface webview { display: flex; width: 100%; height: 100%; }
.embedded-browser.start-page-active .embedded-browser-surface webview { visibility: hidden; }
.embedded-browser.start-page-active.capture-active .embedded-browser-surface webview { visibility: visible; }
.embedded-browser-device-toolbar { display: flex; flex: 0 0 auto; align-items: center; min-height: 38px; gap: 7px; overflow-x: auto; border-bottom: 1px solid var(--line); padding: 4px 8px; background: var(--surface-inset); color: var(--text-muted); }
.embedded-browser-device-toolbar > button { width: 28px; height: 28px; flex: 0 0 28px; }
.embedded-browser-device-toolbar :deep(.embedded-browser-device-select) { width: 160px; min-height: 28px; height: 28px; padding: 0 7px; font-size: 12px; }
.embedded-browser-device-toolbar :deep(.embedded-browser-device-zoom-select) { width: 124px; min-height: 28px; height: 28px; padding: 0 7px; font-size: 12px; }
.embedded-browser-device-field { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; font-size: 12px; }
.embedded-browser-device-field input { width: 56px; height: 28px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface); padding: 0 5px; color: var(--text); font-size: 12px; }
.embedded-browser-device-field input:focus { border-color: var(--brand-accent); box-shadow: 0 0 0 2px var(--brand-accent-soft); }
.embedded-browser-device-times { flex: 0 0 auto; font-size: 12px; }
.embedded-browser-device-stage { position: relative; display: flex; min-width: 0; min-height: 0; flex: 1; align-items: safe center; justify-content: safe center; overflow: auto; background: #fff; }
.embedded-browser-surface.device-mode { background: #16181d; }
.embedded-browser-surface.device-mode .embedded-browser-device-stage { padding: 24px; background: #16181d; }
.embedded-browser-device-scaler { position: relative; flex: none; width: 100%; height: 100%; margin: auto; }
.embedded-browser-device-frame { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; container-type: inline-size; overflow: hidden; background: #fff; }
.embedded-browser-surface.device-mode .embedded-browser-device-frame { border: 0; border-radius: 18px; box-shadow: 0 20px 60px rgb(0 0 0 / 32%); }
.embedded-browser-state { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px; background: var(--surface); color: var(--text-muted); font-size: 12px; }
.embedded-browser-state > svg { color: var(--status-danger); }
.embedded-browser-state-message { max-width: 420px; margin: 0; text-align: center; color: var(--text); font-size: 13px; }
.embedded-browser-state-detail { max-width: 440px; margin: 0; overflow-wrap: anywhere; text-align: center; color: var(--text-muted); font-size: 11px; }
.embedded-browser-start-page { position: absolute; z-index: 1; inset: 0; overflow: auto; pointer-events: auto; background: var(--surface); padding: 34px clamp(12px, 6cqi, 80px); }
.embedded-browser-start-section { max-width: 920px; margin: 0 auto 30px; }
.embedded-browser-start-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.embedded-browser-start-heading h2 { margin: 0; color: var(--text); font-size: 14px; font-weight: 500; }
.embedded-browser-start-count { color: var(--text-muted); font-size: 12px; }
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
.embedded-browser-open-page-row.active { border-color: var(--brand-accent); background: var(--brand-accent-soft); }
.embedded-browser-open-page-current { margin-left: 6px; color: var(--brand-accent); font-size: 11px; font-style: normal; }
.embedded-browser-start-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
.embedded-browser-host-notice { position: absolute; z-index: 2; right: 10px; bottom: 10px; max-width: min(420px, calc(100% - 20px)); margin: 0; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-raised); color: var(--text-muted); font-size: 12px; pointer-events: none; }
.embedded-browser-pinned-form { display: grid; gap: 8px; }
.embedded-browser-pinned-form > label { color: var(--text-muted); font-size: 12px; font-weight: 500; }
.embedded-browser-pinned-error { margin: 0; color: var(--status-danger); font-size: 12px; }
.embedded-browser[data-state="preparing"] .embedded-browser-state > svg { color: var(--brand-accent); animation: embedded-browser-spin 1s linear infinite; }
@keyframes embedded-browser-spin { to { transform: rotate(360deg); } }
</style>
