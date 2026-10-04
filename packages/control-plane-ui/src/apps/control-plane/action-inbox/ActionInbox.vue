<template>
  <aside v-if="!collapsed && (items.length || error)" class="action-inbox" :style="{ top: `${top}px`, right: `${right}px` }" :aria-label="t('navigation.approvals')">
    <Button variant="outline" size="sm" class="action-inbox-collapse" :aria-label="t('navigation.collapseApprovals')" @click="emit('collapse')">
      <ChevronUp :size="16" /> {{ t('navigation.collapseApprovals') }}
    </Button>
    <div v-if="error" role="alert" class="action-inbox-error">{{ error }}</div>
    <ScrollArea v-if="items.length" :horizontal="false" class="action-inbox-stack" :style="{ height: `${Math.min(Math.max(0, availableHeight - 44), visibleCount * 200 + (items.length > visibleCount ? 45 : 0))}px` }">
      <div class="action-inbox-items">
      <article v-for="item in visibleItems" :key="item.key" class="action-inbox-card">
        <template v-if="item.type === 'ai-session-approval'">
          <div class="action-inbox-kind">{{ t('navigation.aiSessionApproval') }}</div>
          <div class="action-inbox-title">{{ item.session.title || item.session.userPrompt || item.session.id }}</div>
          <div class="action-inbox-context">{{ item.instanceName }} · {{ item.session.agent }}</div>
          <div class="action-inbox-actions">
            <Button v-for="decision in item.decisions" :key="decision" size="sm" variant="outline" :disabled="Boolean(busyKey)" @click="emit('resolve', item, decision)">
              {{ t(`sessions.actions.${decision}`) }}
            </Button>
          </div>
        </template>
        <template v-else>
          <div class="action-inbox-kind">{{ t('navigation.operationApproval') }}</div>
          <div class="action-inbox-title">{{ t(operationLabels[item.request.operation]) }}</div>
          <div class="action-inbox-context">{{ item.request.targetId }}</div>
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
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ApprovalOperation } from "@task-handoff/protocol/operation-approvals";
import { useI18n } from "vue-i18n";
import { ChevronUp } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { AiSessionApprovalDecision } from "./aiSessionApprovals";
import { actionInboxPlacement } from "./toastPlacement";
import { visibleToastBounds } from "../../../components/ui/sonner/toastRegion";
import { visibleActionInboxCount, visibleActionInboxItems, type ActionInboxItem } from "./items";

export type Item = ActionInboxItem;
const props = defineProps<{ items: Item[]; collapsed: boolean; busyKey: string; error: string }>();
const emit = defineEmits<{ collapse: []; resolve: [item: Extract<Item, { type: "ai-session-approval" }>, decision: AiSessionApprovalDecision]; decide: [item: Extract<Item, { type: "operation-approval" }>, decision: "approve" | "deny"] }>();
const { t } = useI18n();
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
const offset = ref(0);
const top = ref(76);
const right = ref(18);
const availableHeight = ref(500);
const visibleCount = computed(() => visibleActionInboxCount(availableHeight.value));
const visibleItems = computed(() => visibleActionInboxItems(props.items, offset.value, visibleCount.value));
watch(() => props.items.map((item) => item.key).join("|"), () => { offset.value = 0; });

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
  if (frame) cancelAnimationFrame(frame);
});
</script>

<style scoped>
.action-inbox { position: fixed; right: 18px; width: min(380px, calc(100vw - 36px)); z-index: 40; pointer-events: none; display: grid; justify-items: end; gap: 8px; }
.action-inbox > * { pointer-events: auto; }
.action-inbox-collapse { border-radius: 999px; box-shadow: 0 3px 12px var(--line); }
.action-inbox-stack { width: 100%; }
.action-inbox-items { display: grid; gap: 8px; padding: 0 3px 8px; }
.action-inbox-card { border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-overlay); color: var(--text-strong); box-shadow: 0 8px 24px var(--line); padding: 14px; width: 100%; pointer-events: auto; }
.action-inbox-error { width: 100%; padding: 10px; border-radius: 8px; background: var(--surface-overlay); color: var(--status-danger); font-size: 12px; }
.action-inbox-kind, .action-inbox-context { font-size: 12px; color: var(--text-muted); }
.action-inbox-detail { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-title { font-size: 14px; margin: 6px 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.action-inbox-more { width: calc(100% - 8px); margin: 0 4px 8px; background: var(--surface-overlay); pointer-events: auto; box-shadow: 0 5px 0 -1px var(--surface-overlay), 0 5px 0 0 var(--line-strong), 0 10px 0 -1px var(--surface-overlay), 0 10px 0 0 var(--line-strong); }
</style>
