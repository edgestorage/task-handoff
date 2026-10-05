<template>
  <section v-if="pendingDecisions.length" class="ai-session-detail-decisions">
    <header class="ai-session-detail-decisions-head">
      <CircleHelp :size="14" aria-hidden="true" />
      <span class="ai-session-detail-decisions-title">{{ t("stories.decisions.title") }}</span>
      <span class="ai-session-detail-decisions-count">{{ pendingDecisions.length }}</span>
    </header>
    <ScrollArea type="auto" class="ai-session-detail-decisions-list" :horizontal="false">
      <article v-for="decision in pendingDecisions" :key="decision.id" class="ai-session-detail-decision" :data-decision-id="decision.id">
        <p class="ai-session-detail-decision-question">{{ decision.question }}</p>
        <small v-if="decision.context" class="ai-session-detail-decision-context">{{ t("stories.decisions.context") }}: {{ decision.context }}</small>
        <StoryDecisionAnswer
          :decision="decision"
          :disabled="disabled"
          :busy="busyId === decision.id"
          @submit="(input) => submit(decision, input)"
          @cancel="cancel(decision)"
        />
        <div v-if="actionError?.decisionId === decision.id" class="ai-session-detail-decision-error" role="alert">{{ actionError.message }}</div>
        <div v-if="resumePendingId === decision.id" class="ai-session-detail-decision-resume" role="alert">
          <span>{{ t("stories.decisions.resumePending") }}</span>
          <Button size="sm" variant="outline" :disabled="disabled || busyId === decision.id" @click="retry(decision)">{{ t("stories.decisions.retry") }}</Button>
        </div>
      </article>
    </ScrollArea>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import { CircleHelp } from "@lucide/vue";
import { storyDecisionsQueryOptions } from "../../api/queries.ts";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import StoryDecisionAnswer from "../../apps/control-plane/story/StoryDecisionAnswer.vue";
import { useInSessionDecisionDisplay } from "../../apps/control-plane/story/sessionDecisionDisplay.ts";
import { useStoryDecisionActions } from "../../apps/control-plane/story/useStoryDecisionActions.ts";

const props = withDefaults(defineProps<{
  disabled?: boolean;
  nodeId: string;
  sessionId: string;
  storyId: string;
}>(), {
  disabled: false,
});

const { t } = useI18n();
// 决策的权威归属是 sessionId：这里只呈现当前会话自己的待决策，其他会话由各自会话承担。
const query = useQuery(storyDecisionsQueryOptions(() => props.storyId, () => props.nodeId));
const pendingDecisions = computed(() => (query.data.value?.decisions ?? [])
  .filter((decision) => decision.status === "pending" && decision.sessionId === props.sessionId));
// 会话里已经展示的决策不再出现在右上角浮层，其他会话的决策仍由浮层承担。
useInSessionDecisionDisplay(computed(() => pendingDecisions.value.map((decision) => decision.id)));

const { actionError, busyId, resumePendingId, submit, retry, cancel } = useStoryDecisionActions(() => props.storyId, () => props.nodeId);
</script>

<style scoped>
.ai-session-detail-decisions {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 18px 18px 0 0;
  background: var(--surface-raised);
}

.ai-session-detail-decisions-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  border-bottom: 1px solid var(--line);
  color: var(--text-muted);
  font-size: 12px;
  padding: 4px 12px;
}

.ai-session-detail-decisions-title {
  color: var(--text-strong);
  font-weight: 500;
}

.ai-session-detail-decisions-count {
  color: var(--text-muted);
  font-size: 12px;
}

.ai-session-detail-decisions-list :deep([data-reka-scroll-area-viewport]) {
  max-height: 260px;
}

.ai-session-detail-decision {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
}

.ai-session-detail-decision + .ai-session-detail-decision {
  border-top: 1px solid var(--line);
}

.ai-session-detail-decision-question {
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.ai-session-detail-decision-context {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.ai-session-detail-decision-error {
  color: var(--status-danger);
  font-size: 12px;
}

.ai-session-detail-decision-resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--status-warning, var(--text-muted));
  font-size: 12px;
}
</style>
