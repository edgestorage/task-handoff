<template>
  <div class="story-decisions">
    <div class="story-decisions-heading">
      <div><h3>{{ t("stories.decisions.title") }}</h3><span>{{ decisions.length }}</span></div>
    </div>
    <div v-if="loading" class="story-decision-state">{{ t("stories.decisions.loading") }}</div>
    <div v-else-if="error" class="story-decision-state story-decision-error" role="alert">{{ error }}</div>
    <div v-else-if="!decisions.length" class="story-decision-state">{{ t("stories.decisions.empty") }}</div>
    <div v-for="decision in decisions" :key="decision.id" class="story-decision-row" :data-decision-id="decision.id">
      <div class="story-decision-copy">
        <div class="story-decision-primary">
          <span class="story-decision-status" :data-status="decision.status">{{ statusLabel(decision.status) }}</span>
          <p>{{ decision.question }}</p>
        </div>
        <small v-if="decision.context" class="story-decision-context">{{ t("stories.decisions.context") }}: {{ decision.context }}</small>
        <small v-if="decision.decidedTurnId" class="story-decision-context">{{ t("stories.decisions.decidedTurn") }}</small>
      </div>
      <div v-if="decision.status === 'pending'" class="story-decision-actions">
        <div v-if="decision.options.length" class="story-decision-options">
          <button
            v-for="option in decision.options"
            :key="option.id"
            type="button"
            class="story-decision-option"
            :class="{ selected: selectedOption(decision.id) === option.id }"
            :disabled="disabled || busyId === decision.id"
            @click="selectOption(decision.id, option.id)"
          >{{ option.label }}</button>
        </div>
        <textarea
          v-if="decision.allowFreeText"
          v-model="freeText[decision.id]"
          class="story-decision-field"
          :placeholder="t('stories.decisions.freeTextPlaceholder')"
          :disabled="disabled || busyId === decision.id"
          rows="2"
        />
        <div v-if="resumePendingId === decision.id" class="story-decision-resume" role="alert">
          <span>{{ t("stories.decisions.resumePending") }}</span>
          <Button size="sm" variant="outline" :disabled="disabled || busyId === decision.id" @click="submit(decision, true)">{{ t("stories.decisions.retry") }}</Button>
        </div>
        <div class="story-decision-buttons">
          <Button size="sm" :disabled="disabled || busyId === decision.id || !canSubmit(decision)" @click="submit(decision)">{{ busyId === decision.id ? t("stories.decisions.submitting") : t("stories.decisions.submit") }}</Button>
          <Button variant="ghost" size="sm" :disabled="disabled || busyId === decision.id" @click="cancel(decision)">{{ t("stories.decisions.cancel") }}</Button>
        </div>
      </div>
      <div v-else class="story-decision-readonly">{{ t("stories.decisions.readOnly") }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import type { Story, StoryDecision } from "@task-handoff/protocol/stories";
import { sharedControlPlaneClient } from "../../../api/sharedClient.ts";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { Button } from "../../../components/ui/button";

const props = defineProps<{ story: Story; disabled?: boolean }>();
const { t } = useI18n();

const decisions = ref<StoryDecision[]>([]);
const error = ref("");
const busyId = ref("");
const resumePendingId = ref("");
const selectedOptions = ref<Record<string, string>>({});
const freeText = ref<Record<string, string>>({});

const query = useQuery({
  queryKey: computed(() => controlPlaneQueryKeys.storyDecisions(props.story.ownerNodeId, props.story.id)),
  queryFn: async () => (await sharedControlPlaneClient.stories.listDecisions(props.story.id, props.story.ownerNodeId)).decisions,
  retry: false,
});
const loading = computed(() => query.isPending.value);
watch(() => query.data.value, (data) => { if (data) decisions.value = data; }, { immediate: true });
watch(() => query.error.value, (cause) => { error.value = cause ? (cause instanceof Error ? cause.message : String(cause)) : ""; });

function selectedOption(decisionId: string) { return selectedOptions.value[decisionId]; }
function statusLabel(status: StoryDecision["status"]) {
  if (status === "pending") return t("stories.decisions.pending");
  if (status === "decided") return t("stories.decisions.decided");
  if (status === "cancelled") return t("stories.decisions.cancelled");
  return t("stories.decisions.expired");
}
function selectOption(decisionId: string, optionId: string) {
  selectedOptions.value = { ...selectedOptions.value, [decisionId]: selectedOptions.value[decisionId] === optionId ? "" : optionId };
}
function canSubmit(decision: StoryDecision) {
  return Boolean(selectedOptions.value[decision.id] || freeText.value[decision.id]?.trim());
}
async function submit(decision: StoryDecision, retry = false) {
  busyId.value = decision.id;
  error.value = "";
  try {
    const updated = await sharedControlPlaneClient.stories.decideStory(props.story.id, decision.id, props.story.ownerNodeId, {
      expectedRevision: decision.revision,
      ...(selectedOptions.value[decision.id] ? { optionId: selectedOptions.value[decision.id] } : {}),
      ...(freeText.value[decision.id]?.trim() ? { response: freeText.value[decision.id]!.trim() } : {}),
      ...(retry ? { retry: true } : {}),
    });
    resumePendingId.value = "";
    decisions.value = decisions.value.map((candidate) => candidate.id === updated.id ? updated : candidate);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    resumePendingId.value = isResumePending(cause) ? decision.id : "";
  } finally {
    busyId.value = "";
  }
}

function isResumePending(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && (cause as { code?: string }).code === "STORY_DECISION_RESUME_PENDING");
}
async function cancel(decision: StoryDecision) {
  busyId.value = decision.id;
  error.value = "";
  try {
    const updated = await sharedControlPlaneClient.stories.cancelDecision(props.story.id, decision.id, props.story.ownerNodeId, { expectedRevision: decision.revision });
    decisions.value = decisions.value.map((candidate) => candidate.id === updated.id ? updated : candidate);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busyId.value = "";
  }
}
</script>

<style scoped>
.story-decisions { display:grid; gap:8px; }
.story-decisions-heading { display:flex; align-items:center; justify-content:space-between; }
.story-decisions-heading div { display:flex; align-items:center; gap:8px; }
.story-decisions-heading h3 { font-size:13px; font-weight:600; }
.story-decisions-heading span { color:var(--text-muted); font-size:12px; }
.story-decision-state { color:var(--text-muted); font-size:12px; padding:6px 0; }
.story-decision-error { color:var(--status-danger); }
.story-decision-row { display:grid; gap:8px; border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:var(--surface-inset); }
.story-decision-primary { display:grid; gap:4px; }
.story-decision-status { width:fit-content; font-size:11px; font-weight:600; padding:1px 6px; border-radius:999px; background:var(--surface-active); }
.story-decision-status[data-status="pending"] { background:var(--status-warning-bg, var(--surface-active)); }
.story-decision-copy p { font-size:13px; white-space:pre-wrap; }
.story-decision-context { color:var(--text-muted); font-size:11px; }
.story-decision-actions { display:grid; gap:6px; }
.story-decision-options { display:flex; flex-wrap:wrap; gap:6px; }
.story-decision-option { border:1px solid var(--line); border-radius:6px; padding:4px 10px; font-size:12px; background:var(--surface); }
.story-decision-option.selected { border-color:var(--accent); background:var(--surface-active); }
.story-decision-field { width:100%; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font-size:12px; background:var(--surface); resize:vertical; }
.story-decision-buttons { display:flex; gap:6px; }
.story-decision-resume { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; color:var(--status-warning, var(--text-muted)); }
.story-decision-readonly { color:var(--text-muted); font-size:11px; }
</style>
