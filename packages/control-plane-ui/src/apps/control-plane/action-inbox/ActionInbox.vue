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
                <div class="action-inbox-context">{{ t('navigation.deviceTrust.source') }}: {{ t(`navigation.deviceTrust.sources.${item.request.source}`) }} · {{ t('navigation.deviceTrust.pendingStatus') }}</div>
                <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.reported') }}: {{ item.request.device.kind }} · {{ item.request.device.platform }}<template v-if="item.request.device.version"> · {{ item.request.device.version }}</template></div>
                <div class="action-inbox-context action-inbox-detail" :title="item.request.fingerprint">{{ t('navigation.deviceTrust.fingerprint') }}: {{ item.request.fingerprint }}</div>
                <div class="action-inbox-context">{{ t('navigation.deviceTrust.comparisonCode') }}: <strong class="action-inbox-comparison">{{ item.request.comparisonCode }}</strong></div>
                <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.binding') }}: {{ item.request.bindingId }}</div>
                <div class="action-inbox-context action-inbox-detail">{{ t(`navigation.deviceTrust.accessModes.${item.request.accessMode}`) }} · {{ t('navigation.deviceTrust.account') }}: {{ item.request.accountId }}<template v-if="item.request.accessMode === 'shared'"> · {{ t('navigation.deviceTrust.owner') }}: {{ item.request.ownerAccountId }}</template></div>
                <div class="action-inbox-context action-inbox-detail">{{ t('navigation.deviceTrust.cloudRole') }}: {{ item.request.cloudAccessRoleId }}<template v-if="item.request.shareGrantId"> · {{ t('navigation.deviceTrust.shareGrant') }}: {{ item.request.shareGrantId }}</template></div>
                <div class="action-inbox-context">{{ t('navigation.deviceTrust.requestedAt') }}: {{ formatDate(item.request.requestedAt) }} · {{ t('navigation.deviceTrust.expiresAt') }}: {{ formatDate(item.request.expiresAt) }}</div>
                <Select :model-value="selectedDeviceRoleId(item)" @update:model-value="(value) => setDeviceRole(item, value)">
                  <SelectTrigger class="action-inbox-device-select" :aria-label="t('navigation.deviceTrust.role')">
                    <SelectValue :placeholder="t('navigation.deviceTrust.chooseRole')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="role in activeDeviceRoles(item)" :key="role.roleId" :value="role.roleId">
                      {{ role.name }}<template v-if="role.isAdmin"> · {{ t('navigation.deviceTrust.adminRole') }}</template>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div v-if="!activeDeviceRoles(item).length" class="action-inbox-context">{{ t('navigation.deviceTrust.noRoles') }}</div>
                <div class="action-inbox-actions">
                  <Button size="sm" variant="outline" :disabled="Boolean(busyKey) || !selectedDeviceRoleId(item)" @click="approveDevice(item)">{{ t('navigation.deviceTrust.approve') }}</Button>
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
                <div class="action-inbox-title">{{ t(`navigation.nodeControlPlaneTrust.reasons.${item.trust.reason}`) }}</div>
                <div class="action-inbox-context">{{ t('navigation.nodeControlPlaneTrust.pendingStatus') }}</div>
                <div class="action-inbox-context action-inbox-detail">{{ t('navigation.nodeControlPlaneTrust.node') }}: {{ item.trust.nodeHandle }} · {{ item.nodeId }}</div>
                <div class="action-inbox-context action-inbox-detail" :title="item.trust.controlPlaneFingerprint">{{ t('navigation.nodeControlPlaneTrust.fingerprint') }}: {{ item.trust.controlPlaneFingerprint }}</div>
                <div class="action-inbox-context">{{ t('navigation.nodeControlPlaneTrust.comparisonCode') }}: <strong class="action-inbox-comparison">{{ item.trust.comparisonCode }}</strong></div>
                <div class="action-inbox-context">{{ t('navigation.nodeControlPlaneTrust.requestedAt') }}: {{ formatDate(item.trust.requestedAt) }}<template v-if="item.trust.expiresAt"> · {{ t('navigation.nodeControlPlaneTrust.expiresAt') }}: {{ formatDate(item.trust.expiresAt) }}</template></div>
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
import { BookOpen, ChevronUp, ExternalLink, ShieldCheck, ShieldQuestion } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
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
  "decide-device": [item: Extract<Item, { type: "device-trust" }>, decision: { decision: "approve"; roleId: string } | { decision: "reject" }];
  "decide-node-control-plane": [item: Extract<Item, { type: "node-control-plane-trust" }>, decision: "approve" | "reject"];
  "decide-story": [item: StoryDecisionItem, input: { optionId?: string; response?: string }];
  "cancel-story": [item: StoryDecisionItem];
  "open-story": [item: StoryDecisionItem];
  "open-story-session": [item: StoryDecisionItem];
}>();
const { locale, t } = useI18n();
const deviceRoleSelections = ref<Record<string, string>>({});
const activeDeviceRoles = (item: Extract<Item, { type: "device-trust" }>) => item.roles.filter((role) => role.status === "active");
const formatDate = (value: string) => formatDateTime(value, locale.value as SupportedLocale);
function selectedDeviceRoleId(item: Extract<Item, { type: "device-trust" }>) {
  const roleId = deviceRoleSelections.value[item.key];
  return roleId && activeDeviceRoles(item).some((role) => role.roleId === roleId) ? roleId : undefined;
}
function setDeviceRole(item: Extract<Item, { type: "device-trust" }>, value: unknown) {
  if (typeof value === "string") deviceRoleSelections.value[item.key] = value;
}
function approveDevice(item: Extract<Item, { type: "device-trust" }>) {
  const roleId = selectedDeviceRoleId(item);
  if (roleId) emit("decide-device", item, { decision: "approve", roleId });
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
watch(() => props.items.map((item) => item.key).join("|"), () => { offset.value = 0; });

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
.action-inbox-detail { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-title { font-size: 14px; margin: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.action-inbox-more { width: 100%; height: auto; padding: 8px 12px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
</style>
