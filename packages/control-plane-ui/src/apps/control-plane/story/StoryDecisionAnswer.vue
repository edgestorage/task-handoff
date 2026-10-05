<template>
  <div class="story-decision-answer">
    <div class="story-decision-choices" role="radiogroup" :aria-label="decision.question">
      <button
        v-for="(option, index) in decision.options"
        :key="option.id"
        type="button"
        role="radio"
        class="story-decision-choice"
        :aria-checked="selectedOptionId === option.id"
        :disabled="disabled || busy"
        @click="chooseOption(option.id)"
        @keydown="handleChoiceKeydown"
      >
        <span class="story-decision-choice-index" aria-hidden="true">{{ index + 1 }}</span>
        <span class="story-decision-choice-label">{{ option.label }}</span>
      </button>
      <button
        v-if="decision.allowFreeText"
        type="button"
        role="radio"
        class="story-decision-choice"
        :aria-checked="replySelected"
        :disabled="disabled || busy"
        @click="chooseReply"
        @keydown="handleChoiceKeydown"
      >
        <span class="story-decision-choice-index" aria-hidden="true">{{ decision.options.length + 1 }}</span>
        <span class="story-decision-choice-label">{{ t("stories.decisions.replyOption") }}</span>
      </button>
      <div v-if="replySelected" class="story-decision-reply">
        <Textarea
          v-model="response"
          class="min-h-0 resize-y text-xs"
          :placeholder="t('stories.decisions.freeTextPlaceholder')"
          :disabled="disabled || busy"
          rows="2"
        />
      </div>
    </div>
    <div class="story-decision-buttons">
      <Button variant="outline" size="sm" :disabled="disabled || busy || !canSubmit" @click="submit">
        {{ busy ? t("stories.decisions.submitting") : t("stories.decisions.submit") }}
      </Button>
      <Button variant="ghost" size="sm" :disabled="disabled || busy" @click="emit('cancel')">{{ t("stories.decisions.cancel") }}</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { StoryDecision } from "@task-handoff/protocol/stories";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import type { StoryDecisionAnswerInput } from "./storyDecisionPresentation.ts";

const props = defineProps<{ decision: StoryDecision; disabled?: boolean; busy?: boolean }>();
const emit = defineEmits<{ submit: [input: StoryDecisionAnswerInput]; cancel: [] }>();
const { t } = useI18n();

const optionId = ref("");
const replyPicked = ref(false);
const response = ref("");

// 只允许自由文本的决策没有可选项，回复就是唯一答案，直接展开。
const replySelected = computed(() => replyPicked.value || (!props.decision.options.length && props.decision.allowFreeText));
const selectedOptionId = computed(() => optionId.value);
const canSubmit = computed(() => Boolean(optionId.value) || (replySelected.value && Boolean(response.value.trim())));

watch(() => props.decision.id, () => {
  optionId.value = "";
  replyPicked.value = false;
  response.value = "";
});

function chooseOption(id: string) {
  optionId.value = id;
  replyPicked.value = false;
}
function chooseReply() {
  optionId.value = "";
  replyPicked.value = true;
}
function handleChoiceKeydown(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const current = event.currentTarget as HTMLButtonElement;
  const group = current.closest(".story-decision-choices");
  if (!group) return;
  const choices = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'));
  const index = choices.indexOf(current);
  if (index < 0 || !choices.length) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const next = choices[(index + step + choices.length) % choices.length];
  next.focus();
  next.click();
}
function submit() {
  if (!canSubmit.value || props.disabled || props.busy) return;
  emit("submit", {
    ...(optionId.value ? { optionId: optionId.value } : {}),
    ...(replySelected.value && response.value.trim() ? { response: response.value.trim() } : {}),
  });
}
</script>

<style scoped>
.story-decision-answer { display:grid; gap:8px; min-width:0; }
.story-decision-choices { display:grid; gap:2px; min-width:0; }
.story-decision-choice { display:flex; width:100%; min-height:34px; align-items:center; gap:10px; border:1px solid transparent; border-radius:7px; background:transparent; color:var(--text); cursor:pointer; font-size:12px; line-height:1.4; padding:4px 8px; text-align:left; }
.story-decision-choice:not([aria-checked="true"]):hover:not(:disabled) { background:var(--surface-hover); }
.story-decision-choice:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-1px; }
.story-decision-choice[aria-checked="true"] { border-color:color-mix(in srgb,var(--brand-accent) 55%,var(--line)); background:var(--brand-accent-soft); color:var(--text-strong); }
.story-decision-choice:disabled { cursor:default; opacity:.55; }
.story-decision-choice-index { display:grid; flex:0 0 auto; width:20px; height:20px; place-items:center; border-radius:6px; background:var(--surface-active); color:var(--text-muted); font-size:11px; font-variant-numeric:tabular-nums; }
.story-decision-choice[aria-checked="true"] .story-decision-choice-index { background:var(--brand-accent); color:var(--brand-accent-foreground); }
.story-decision-choice-label { min-width:0; overflow-wrap:anywhere; }
.story-decision-reply { margin:2px 0 2px 30px; }
.story-decision-buttons { display:flex; gap:8px; }
</style>
