<template>
  <Transition name="action-inbox-panel">
    <aside v-if="!collapsed && (items.length || error)" class="action-inbox" :style="{ top: `${top}px`, right: `${right}px` }" :aria-label="t('navigation.approvals')">
      <Button variant="outline" size="sm" class="action-inbox-collapse" :aria-label="t('navigation.collapseApprovals')" @click="emit('collapse')">
        <ChevronUp :size="16" /> {{ t('navigation.collapseApprovals') }}
      </Button>
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
  "decide-story": [item: StoryDecisionItem, input: { optionId?: string; response?: string }];
  "cancel-story": [item: StoryDecisionItem];
  "open-story": [item: StoryDecisionItem];
  "open-story-session": [item: StoryDecisionItem];
}>();
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
const itemsElement = ref<HTMLElement | null>(null);
const itemsHeight = ref(0);
let itemsResizeObserver: ResizeObserver | undefined;
/* The hit area follows the rendered cards, so the empty room of a taller scroll box cannot swallow clicks meant for the page below. */
const stackHeight = computed(() => Math.min(itemsHeight.value, Math.max(0, availableHeight.value - 44)));
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
.action-inbox { --action-inbox-inset: 28px; position: fixed; right: 18px; width: min(380px, calc(100vw - 36px)); z-index: 40; pointer-events: none; display: grid; justify-items: end; gap: 8px; transform-origin: top right; }
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
.action-inbox-collapse { margin-right: var(--action-inbox-inset); border-radius: 999px; box-shadow: 0 3px 28px var(--shadow-color); }
.action-inbox-stack { width: 100%; }
/* The scroll viewport clips card shadows, so the items inset the border box by the 28px blur reach: 24px above and 32px below for the 4px y-offset, 28px on the sides. */
.action-inbox-items { display: grid; gap: 8px; padding: 24px var(--action-inbox-inset) 32px; }
.action-inbox-card { display: grid; align-content: start; gap: 4px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-overlay); color: var(--text-strong); box-shadow: 0 4px 28px var(--shadow-color); padding: 10px; width: 100%; pointer-events: auto; }
.action-inbox-error { justify-self: stretch; margin: 0 var(--action-inbox-inset); padding: 10px; border-radius: 8px; background: var(--surface-overlay); color: var(--status-danger); font-size: 12px; }
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
.action-inbox-detail { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-title { font-size: 14px; margin: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.action-inbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.action-inbox-more { width: calc(100% - 8px); margin: 0 4px; background: var(--surface-overlay); pointer-events: auto; box-shadow: 0 5px 0 -1px var(--surface-overlay), 0 5px 0 0 var(--line-strong), 0 10px 0 -1px var(--surface-overlay), 0 10px 0 0 var(--line-strong); }
</style>
