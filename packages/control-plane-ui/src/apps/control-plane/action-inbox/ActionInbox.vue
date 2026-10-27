<template>
  <Transition name="action-inbox-panel">
    <aside v-if="!collapsed && (items.length || error)" class="action-inbox" :style="{ top: `${top}px`, right: `${right}px` }" :aria-label="t('navigation.approvals')">
      <Button variant="outline" size="sm" class="action-inbox-collapse" :aria-label="t('navigation.collapseApprovals')" @click="emit('collapse')">
        <ChevronUp :size="16" /> {{ t('navigation.collapseApprovals') }}
      </Button>
      <div class="action-inbox-panel">
        <div v-if="error" role="alert" class="action-inbox-error">{{ error }}</div>
        <ScrollArea v-if="items.length" :horizontal="false" class="action-inbox-stack" :style="{ height: `${stackHeight}px` }">
          <div ref="itemsElement" class="action-inbox-items">
            <article v-for="item in visibleItems" :key="item.key" class="action-inbox-card">
              <template v-if="item.type === 'ai-session-approval'">
                <header class="action-inbox-head">
                  <span class="action-inbox-kind">
                    <ShieldQuestion :size="13" aria-hidden="true" />
                    {{ t('navigation.aiSessionApproval') }}
                  </span>
                  <span class="action-inbox-source" :title="`${item.instanceName} · ${item.session.agent}`">{{ item.instanceName }} · {{ item.session.agent }}</span>
                </header>
                <div class="action-inbox-title">{{ item.session.title || item.session.userPrompt || item.session.id }}</div>
                <div class="action-inbox-actions">
                  <Button v-for="decision in item.decisions" :key="decision" size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('resolve', item, decision)">
                    {{ t(`sessions.actions.${decision}`) }}
                  </Button>
                </div>
              </template>
              <template v-else-if="item.type === 'story-decision'">
                <header class="action-inbox-head">
                  <span class="action-inbox-kind action-inbox-kind-label-only">{{ t('navigation.storyDecision') }}</span>
                  <button type="button" class="action-inbox-source action-inbox-story-link" :title="item.story.title" @click="emit('open-story', item)">
                    <BookOpen class="action-inbox-story-icon" :size="13" aria-hidden="true" />
                    <span class="action-inbox-story-title">{{ item.story.title }}</span>
                  </button>
                  <Button variant="ghost" size="icon-sm" class="action-inbox-open-session" :aria-label="t('stories.decisions.openSession')" :title="t('stories.decisions.openSession')" @click="emit('open-story-session', item)"><ExternalLink :size="12" /></Button>
                </header>
                <div class="action-inbox-title" :title="item.decision.question">{{ item.decision.question }}</div>
                <div v-if="item.decision.context" class="action-inbox-context action-inbox-detail" :title="item.decision.context">{{ t('stories.decisions.context') }}: {{ item.decision.context }}</div>
                <StoryDecisionAnswer
                  :key="item.decision.id"
                  class="action-inbox-answer"
                  :decision="item.decision"
                  :disabled="Boolean(busyKey)"
                  :busy="busyKey === item.key"
                  @submit="(input) => emit('decide-story', item, input)"
                  @cancel="emit('cancel-story', item)"
                />
              </template>
              <template v-else-if="item.type === 'device-trust'">
                <header class="action-inbox-head">
                  <span class="action-inbox-kind">
                    <ShieldCheck :size="13" aria-hidden="true" />
                    {{ t('navigation.deviceTrust.title') }}
                  </span>
                  <span class="action-inbox-source" :title="item.request.device.name">{{ item.request.device.name }}</span>
                </header>
                <div class="action-inbox-title" :title="item.request.device.name">
                  {{ t(`navigation.deviceTrust.reasons.${item.request.reason}`) }}
                </div>
                <div class="action-inbox-trust-code">
                  <span>{{ t('navigation.deviceTrust.comparisonCode') }}</span>
                  <TooltipProvider :delay-duration="200">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <button type="button" class="action-inbox-info" :aria-label="t('navigation.deviceTrust.comparisonCode')">
                          <InfoIcon :size="12" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="start">{{ t('navigation.trustApproval.comparisonCodeHint') }}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <strong class="action-inbox-comparison">{{ item.request.comparisonCode }}</strong>
                </div>
                <div class="action-inbox-context">{{ formatExpiryRelative(item.request.expiresAt) }}</div>
                <button type="button" class="action-inbox-details-toggle" :aria-expanded="trustDetailsOpen(item)" @click="toggleTrustDetails(item)">
                  {{ trustDetailsOpen(item) ? t('navigation.trustApproval.hideDetails') : t('navigation.trustApproval.showDetails') }}
                  <ChevronDown :size="12" :class="{ open: trustDetailsOpen(item) }" />
                </button>
                <div v-if="trustDetailsOpen(item)" class="action-inbox-details">
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.source') }}: {{ t(`navigation.deviceTrust.sources.${item.request.source}`) }}</div>
                  <div class="action-inbox-context action-inbox-detail" :title="item.request.fingerprint">{{ t('navigation.deviceTrust.fingerprint') }}: {{ item.request.fingerprint }}</div>
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.reported') }}: {{ item.request.device.kind }} · {{ item.request.device.platform }}<template v-if="item.request.device.version"> · {{ item.request.device.version }}</template></div>
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.binding') }}: {{ item.request.bindingId }}</div>
                  <div class="action-inbox-context action-inbox-detail">{{ t(`navigation.deviceTrust.accessModes.${item.request.accessMode}`) }} · {{ t('navigation.deviceTrust.account') }}: {{ item.request.accountId }}<template v-if="item.request.accessMode === 'shared'"> · {{ t('navigation.deviceTrust.owner') }}: {{ item.request.ownerAccountId }}</template></div>
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.cloudRole') }}: {{ item.request.cloudAccessRoleId }}<template v-if="item.request.shareGrantId"> · {{ t('navigation.deviceTrust.shareGrant') }}: {{ item.request.shareGrantId }}</template></div>
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.trustApproval.requestId') }}: {{ item.request.requestId }}</div>
                  <div class="action-inbox-context">{{ t('navigation.deviceTrust.requestedAt') }}: {{ formatDate(item.request.requestedAt) }} · {{ t('navigation.deviceTrust.expiresAt') }}: {{ formatDate(item.request.expiresAt) }}</div>
                </div>
                <div class="action-inbox-context">{{ t('navigation.trustApproval.role') }}: <strong>{{ deviceRoleName(item) }}</strong></div>
                <div v-if="!deviceRoleAvailable(item)" class="action-inbox-context">{{ t('navigation.trustApproval.roleUnavailable') }}</div>
                <div class="action-inbox-actions">
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey) || !deviceRoleAvailable(item)" @click="emit('decide-device', item, { decision: 'approve' })">{{ t('navigation.deviceTrust.approve') }}</Button>
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('decide-device', item, { decision: 'reject' })">{{ t('navigation.deviceTrust.reject') }}</Button>
                </div>
              </template>
              <template v-else-if="item.type === 'node-control-plane-trust'">
                <header class="action-inbox-head">
                  <span class="action-inbox-kind">
                    <ShieldCheck :size="13" aria-hidden="true" />
                    {{ t('navigation.nodeControlPlaneTrust.title') }}
                  </span>
                  <span class="action-inbox-source" :title="item.trust.nodeHandle">{{ item.trust.displayName || item.trust.nodeHandle }}</span>
                </header>
                <div class="action-inbox-title">{{ nodeTrustTitle(item.trust.reason) }}</div>
                <div class="action-inbox-trust-code">
                  <span>{{ t('navigation.nodeControlPlaneTrust.comparisonCode') }}</span>
                  <TooltipProvider :delay-duration="200">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <button type="button" class="action-inbox-info" :aria-label="t('navigation.nodeControlPlaneTrust.comparisonCode')">
                          <InfoIcon :size="12" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="start">{{ t('navigation.trustApproval.nodeComparisonCodeHint') }}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <strong class="action-inbox-comparison">{{ item.trust.comparisonCode }}</strong>
                </div>
                <div v-if="item.trust.expiresAt" class="action-inbox-context">{{ formatExpiryRelative(item.trust.expiresAt) }}</div>
                <button type="button" class="action-inbox-details-toggle" :aria-expanded="trustDetailsOpen(item)" @click="toggleTrustDetails(item)">
                  {{ trustDetailsOpen(item) ? t('navigation.trustApproval.hideDetails') : t('navigation.trustApproval.showDetails') }}
                  <ChevronDown :size="12" :class="{ open: trustDetailsOpen(item) }" />
                </button>
                <div v-if="trustDetailsOpen(item)" class="action-inbox-details">
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.trustApproval.controlPlaneId') }}: {{ item.trust.controlPlaneId }}</div>
                  <div class="action-inbox-context action-inbox-detail" :title="item.trust.controlPlaneFingerprint">{{ t('navigation.nodeControlPlaneTrust.fingerprint') }}: {{ item.trust.controlPlaneFingerprint }}</div>
                  <div class="action-inbox-context action-inbox-detail">{{ t('navigation.nodeControlPlaneTrust.node') }}: {{ item.trust.nodeHandle }} · {{ item.nodeId }}</div>
                  <div v-if="item.trust.requestId" class="action-inbox-context action-inbox-detail">{{ t('navigation.trustApproval.requestId') }}: {{ item.trust.requestId }}</div>
                  <div class="action-inbox-context">{{ t('navigation.nodeControlPlaneTrust.requestedAt') }}: {{ formatDate(item.trust.requestedAt) }}<template v-if="item.trust.expiresAt"> · {{ t('navigation.nodeControlPlaneTrust.expiresAt') }}: {{ formatDate(item.trust.expiresAt) }}</template></div>
                  <div v-if="item.trust.reason" class="action-inbox-context">{{ t('navigation.nodeControlPlaneTrust.reason') }}: {{ t(`navigation.nodeControlPlaneTrust.reasons.${item.trust.reason}`) }}</div>
                </div>
                <div class="action-inbox-actions">
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('decide-node-control-plane', item, 'approve')">{{ t('navigation.nodeControlPlaneTrust.approve') }}</Button>
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('decide-node-control-plane', item, 'reject')">{{ t('navigation.nodeControlPlaneTrust.reject') }}</Button>
                </div>
              </template>
              <template v-else>
                <header class="action-inbox-head">
                  <span class="action-inbox-kind">
                    <ShieldCheck :size="13" aria-hidden="true" />
                    {{ t('navigation.operationApproval') }}
                  </span>
                  <span class="action-inbox-source" :title="item.request.targetId">{{ item.request.targetId }}</span>
                </header>
                <div class="action-inbox-title">{{ t(operationLabels[item.request.operation]) }}</div>
                <div v-for="detail in item.request.details" :key="detail.field" class="action-inbox-context action-inbox-detail" :title="detail.value">{{ t(`navigation.approvalFields.${detail.field}`) }}: {{ detail.value }}</div>
                <div class="action-inbox-actions">
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('decide', item, 'approve')">{{ t('navigation.approveOperation') }}</Button>
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('decide', item, 'deny')">{{ t('navigation.denyOperation') }}</Button>
                </div>
              </template>
            </article>
            <Button v-if="items.length > visibleCount" size="sm" variant="outline" class="action-inbox-more" :aria-label="t('navigation.moreApprovals', { count: items.length - visibleCount })" @click="offset = (offset + visibleCount) % items.length">
              {{ t('navigation.moreApprovals', { count: items.length - visibleCount }) }}
            </Button>
          </div>
        </ScrollArea>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ApprovalOperation } from "@task-handoff/protocol/operation-approvals";
import { useI18n } from "vue-i18n";
import { BookOpen, ChevronDown, ChevronUp, ExternalLink, InfoIcon, ShieldCheck, ShieldQuestion } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import type { AiSessionApprovalDecision } from "./aiSessionApprovals";
import { actionInboxPlacement } from "./toastPlacement";
import { visibleToastBounds } from "../../../components/ui/sonner/toastRegion";
import { visibleActionInboxCount, visibleActionInboxItems, type ActionInboxItem } from "./items";
import StoryDecisionAnswer from "../story/StoryDecisionAnswer.vue";

export type Item = ActionInboxItem;
const props = defineProps<{ items: Item[]; collapsed: boolean; busyKey: string; error: string }>();
type StoryDecisionItem = Extract<Item, { type: "story-decision" }>;
const emit = defineEmits<{
  collapse: [];
  resolve: [item: Extract<Item, { type: "ai-session-approval" }>, decision: AiSessionApprovalDecision];
  decide: [item: Extract<Item, { type: "operation-approval" }>, decision: "approve" | "deny"];
  "decide-device": [item: Extract<Item, { type: "device-trust" }>, decision: { decision: "approve" } | { decision: "reject" }];
  "decide-node-control-plane": [item: Extract<Item, { type: "node-control-plane-trust" }>, decision: "approve" | "reject"];
  "decide-story": [item: StoryDecisionItem, input: { optionId?: string; response?: string }];
  "cancel-story": [item: StoryDecisionItem];
  "open-story": [item: StoryDecisionItem];
  "open-story-session": [item: StoryDecisionItem];
}>();
const { locale, t } = useI18n();
const expandedTrustDetails = ref<Set<string>>(new Set());
const formatDate = (value: string) => formatDateTime(value, locale.value as SupportedLocale);
function deviceRoleName(item: Extract<Item, { type: "device-trust" }>) {
  return item.roles.find((role) => role.roleId === item.request.cloudAccessRoleId)?.name || item.request.cloudAccessRoleId;
}
function deviceRoleAvailable(item: Extract<Item, { type: "device-trust" }>) {
  return item.roles.some((role) => role.roleId === item.request.cloudAccessRoleId && role.status === "active");
}
function trustDetailsOpen(item: { key: string }) {
  return expandedTrustDetails.value.has(item.key);
}
function toggleTrustDetails(item: { key: string }) {
  const next = new Set(expandedTrustDetails.value);
  if (next.has(item.key)) next.delete(item.key);
  else next.add(item.key);
  expandedTrustDetails.value = next;
}
function formatExpiryRelative(value: string | undefined) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return formatDate(value);
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return t("navigation.trustApproval.expired");
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return t("navigation.trustApproval.expiresInMinutes", { count: minutes });
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return t("navigation.trustApproval.expiresInHours", { count: hours });
  return t("navigation.trustApproval.expiresInDays", { count: Math.ceil(hours / 24) });
}
function nodeTrustTitle(reason: string | undefined) {
  if (reason === "key-changed" || reason === "access-context-changed") {
    return t(`navigation.nodeControlPlaneTrust.reasons.${reason}`);
  }
  return t("navigation.trustApproval.nodeFirstSeen");
}
const operationLabels: Record<ApprovalOperation, string> = {
  "instance.delete": "navigation.instanceDeleteApproval",
  "node.remove": "navigation.nodeRemoveApproval",
  "node.update.apply": "navigation.nodeUpdateApproval",
  "node.external-listener.set": "navigation.nodeExternalListenerApproval",
  "user.access.set": "navigation.userAccessApproval",
  "user.role.update": "navigation.roleUpdateApproval",
  "user.role.remove": "navigation.roleRemoveApproval",
  "identity-provider.update": "navigation.identityProviderUpdateApproval",
  "identity-provider.remove": "navigation.identityProviderRemoveApproval",
  "git-credential.assign": "navigation.gitCredentialAssignApproval",
};
/* The tab merges into the panel's top border, so only the part sticking out above the edge is charged against the available height. */
const panelHandleHeight = 31;
const offset = ref(0);
const top = ref(76);
const right = ref(18);
const availableHeight = ref(500);
const visibleCount = computed(() => visibleActionInboxCount(availableHeight.value));
const visibleItems = computed(() => visibleActionInboxItems(props.items, offset.value, visibleCount.value));
const itemsElement = ref<HTMLElement | null>(null);
const itemsHeight = ref(0);
let itemsResizeObserver: ResizeObserver | undefined;
const stackHeight = computed(() => Math.min(itemsHeight.value, Math.max(0, availableHeight.value - panelHandleHeight)));
watch(() => props.items.map((item) => item.key).join("|"), () => {
  offset.value = 0;
  const keys = new Set(props.items.map((item) => item.key));
  expandedTrustDetails.value = new Set([...expandedTrustDetails.value].filter((key) => keys.has(key)));
});

function observeItemsHeight() {
  itemsResizeObserver?.disconnect();
  itemsResizeObserver = undefined;
  const element = itemsElement.value;
  itemsHeight.value = element?.offsetHeight ?? 0;
  if (!element || typeof ResizeObserver === "undefined") return;
  itemsResizeObserver = new ResizeObserver(() => { itemsHeight.value = element.offsetHeight; });
  itemsResizeObserver.observe(element);
}
watch(itemsElement, observeItemsHeight);

let frame = 0;

function measure() {
  frame = 0;
  const placement = actionInboxPlacement(window.innerWidth, window.innerHeight, visibleToastBounds.value);
  top.value = placement.top;
  right.value = placement.right;
  availableHeight.value = placement.availableHeight;
}

function scheduleMeasure() {
  if (!frame) frame = requestAnimationFrame(measure);
}

watch(visibleToastBounds, scheduleMeasure);
onMounted(() => {
  window.addEventListener('resize', scheduleMeasure);
  scheduleMeasure();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleMeasure);
  itemsResizeObserver?.disconnect();
  itemsResizeObserver = undefined;
  if (frame) cancelAnimationFrame(frame);
});
</script>

<style scoped>
.action-inbox { position: fixed; right: 18px; width: min(380px, calc(100vw - 36px)); z-index: 40; pointer-events: none; display: grid; justify-items: end; transform-origin: top right; }
.action-inbox > * { pointer-events: auto; }
.action-inbox-panel-enter-active,
.action-inbox-panel-leave-active {
  transition: opacity 160ms ease, transform 200ms cubic-bezier(0.2, 0, 0, 1);
}
.action-inbox-panel-enter-from,
.action-inbox-panel-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
/* The leaving panel keeps its last layer while fading, so drop its hit area with it. */
.action-inbox-panel-leave-active,
.action-inbox-panel-leave-active > * {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .action-inbox-panel-enter-active,
  .action-inbox-panel-leave-active {
    transition-duration: 0.01ms;
  }
}
/* Every visible decision shares one surface; the rows split on shared dividers instead of stacking separate cards. */
/* The top-right corner stays square so the tab's right edge and the panel's right edge read as one straight line down. */
.action-inbox-panel { width: 100%; display: grid; border: 1px solid var(--line-strong); border-radius: 12px 0 12px 12px; background: var(--surface-overlay); color: var(--text-strong); box-shadow: 0 4px 28px var(--shadow-color); overflow: hidden; }
.action-inbox-panel > * + * { border-top: 1px solid var(--line); }
/* The collapse control is a tab pinned to the panel's top-right: rounded top corners and an open, borderless bottom that merges into the panel surface, so it reads as one piece with the panel instead of a floating capsule. */
.action-inbox-collapse { position: relative; z-index: 1; margin: 0 0 -1px 0; border: 1px solid var(--line-strong); border-bottom: 0; border-radius: 10px 10px 0 0; background: var(--surface-overlay); color: var(--text-strong); box-shadow: none; }
/* The tab base flares into the panel with a concave fillet: a quarter circle centred on the junction curves the tab border into the panel's top border. The crescent outside the arc is all that stays opaque, so the flare bends inward instead of kicking out a convex step. */
.action-inbox-collapse::before { content: ""; position: absolute; left: -12px; bottom: 0; width: 12px; height: 12px; background: var(--line-strong); -webkit-mask: radial-gradient(circle at 0 0, transparent 11px, #000 11px, #000 12px, transparent 12px); mask: radial-gradient(circle at 0 0, transparent 11px, #000 11px, #000 12px, transparent 12px); }
.action-inbox-collapse::after { content: ""; position: absolute; left: -12px; bottom: 0; width: 12px; height: 12px; background: var(--surface-overlay); -webkit-mask: radial-gradient(circle at 0 0, transparent 12px, #000 12px); mask: radial-gradient(circle at 0 0, transparent 12px, #000 12px); }
.action-inbox-collapse:not(:disabled):hover { background: var(--surface-hover); }
.action-inbox-collapse:not(:disabled):hover::before { background: var(--surface-hover); }
.action-inbox-collapse:not(:disabled):hover::after { background: var(--surface-hover); }
.action-inbox-stack { width: 100%; }
.action-inbox-items { display: grid; }
.action-inbox-items > * + * { border-top: 1px solid var(--line); }
.action-inbox-card { display: grid; align-content: start; gap: 4px; padding: 12px; width: 100%; }
.action-inbox-error { padding: 10px 12px; color: var(--status-danger); font-size: 12px; }
.action-inbox-head { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 6px; }
.action-inbox-kind { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; border-radius: 999px; background: var(--surface-hover); color: var(--text-muted); font-size: 12px; font-weight: 500; line-height: 16px; padding: 2px 8px 2px 6px; }
.action-inbox-kind-label-only { padding: 2px 8px; }
.action-inbox-kind svg { flex: 0 0 auto; }
.action-inbox-source { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.action-inbox-story-link { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; cursor: pointer; font-family: inherit; font-size: 12px; padding: 0; text-align: left; }
.action-inbox-story-icon { flex: 0 0 auto; }
.action-inbox-story-link:not(:disabled):hover .action-inbox-story-title { text-decoration: underline; }
.action-inbox-story-link:focus-visible { border-radius: 4px; outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.action-inbox-story-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-inbox-open-session { flex: 0 0 auto; color: var(--text-muted); }
.action-inbox-context { font-size: 12px; color: var(--text-muted); }
.action-inbox-comparison { color: var(--text-strong); font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-weight: 500; letter-spacing: 0.04em; }
.action-inbox-device-select { height: 30px; margin-top: 4px; font-size: 12px; }
.action-inbox-trust-code { align-items: center; color: var(--text-muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 4px; }
.action-inbox-info { align-items: center; background: transparent; border: 0; border-radius: 4px; color: var(--text-muted); cursor: help; display: inline-flex; padding: 2px; }
.action-inbox-info:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.action-inbox-details-toggle { align-items: center; align-self: flex-start; background: transparent; border: 0; border-radius: 4px; color: var(--text-muted); cursor: pointer; display: inline-flex; font: inherit; font-size: 12px; gap: 3px; margin-top: 2px; padding: 0; }
.action-inbox-details-toggle:hover { color: var(--text-strong); }
.action-inbox-details-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.action-inbox-details-toggle svg { transition: transform 140ms ease; }
.action-inbox-details-toggle svg.open { transform: rotate(180deg); }
.action-inbox-details { display: grid; gap: 4px; padding-top: 4px; }
.action-inbox-details .action-inbox-detail { display: block; overflow: visible; -webkit-line-clamp: unset; }
.action-inbox-detail { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-title { font-size: 14px; margin: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.action-inbox-more { width: 100%; height: auto; padding: 8px 12px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
</style>
