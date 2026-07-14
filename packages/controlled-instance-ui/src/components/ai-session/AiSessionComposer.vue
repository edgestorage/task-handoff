<script setup lang="ts">
import { computed } from "vue";
import { ArrowUp, CornerDownRight, Plus, Square } from "@lucide/vue";
import { Textarea } from "../ui/textarea";

const props = defineProps<{
  modelValue: string;
  busy?: boolean;
  canInterrupt?: boolean;
  error?: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "add-context"): void;
  (event: "run"): void;
  (event: "steer"): void;
}>();

const draft = computed({
  get: () => props.modelValue,
  set: (value: string | number) => emit("update:modelValue", String(value)),
});

const hasDraft = computed(() => props.modelValue.trim().length > 0);
const actionKind = computed(() => hasDraft.value || !props.canInterrupt ? "send" : "stop");
const canRun = computed(() => hasDraft.value || (!props.busy && props.canInterrupt));
const canSteer = computed(() => props.busy && hasDraft.value);
const actionTitle = computed(() => actionKind.value === "stop" ? "Stop current AI turn" : "Send message");

function submit() {
  if (canRun.value) {
    emit("run");
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  submit();
}
</script>

<template>
  <form class="ai-session-composer" @submit.prevent="submit">
    <Textarea
      v-model="draft"
      class="ai-session-composer__input"
      :placeholder="placeholder || 'Ask for follow-up changes'"
      rows="4"
      @keydown="handleInputKeydown"
    />
    <div class="ai-session-composer__toolbar">
      <button
        type="button"
        class="ai-session-composer__tool"
        title="Add context"
        @click="emit('add-context')"
      >
        <Plus :size="18" />
      </button>
      <div class="ai-session-composer__actions">
        <button
          v-if="canSteer"
          type="button"
          class="ai-session-composer__tool"
          title="Steer current AI turn"
          @click="emit('steer')"
        >
          <CornerDownRight :size="18" />
        </button>
        <button
          type="submit"
          class="ai-session-composer__primary"
          :data-action="actionKind"
          :disabled="!canRun"
          :title="actionTitle"
        >
          <ArrowUp v-if="actionKind === 'send'" :size="18" />
          <Square v-else :size="16" />
        </button>
      </div>
    </div>
    <p v-if="error" class="ai-session-composer__error">{{ error }}</p>
  </form>
</template>

<style scoped>
.ai-session-composer {
  display: grid;
  grid-template-rows: minmax(96px, auto) auto;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ai-composer-border, var(--border));
  border-radius: 18px;
  background: var(--ai-composer-bg, var(--background));
  box-shadow: var(--ai-composer-shadow, none);
}

.ai-session-composer__input {
  min-height: 104px;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--ai-composer-text, currentColor);
  font-size: 14px;
  line-height: 1.45;
  padding: 16px 18px 8px;
  resize: vertical;
}

.ai-session-composer__input:focus-visible {
  outline: none;
  box-shadow: none;
}

.ai-session-composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 8px 10px 10px;
}

.ai-session-composer__actions {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.ai-session-composer__tool,
.ai-session-composer__primary {
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.ai-session-composer__tool {
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--ai-composer-muted, currentColor);
}

.ai-session-composer__primary {
  width: 34px;
  height: 34px;
  background: var(--ai-composer-primary-bg, var(--primary));
  color: var(--ai-composer-primary-text, var(--primary-foreground));
}

.ai-session-composer__primary[data-action="stop"] {
  background: var(--ai-composer-stop-bg, var(--destructive));
  color: var(--ai-composer-stop-text, var(--destructive-foreground));
}

.ai-session-composer__primary:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-composer__error {
  margin: 0;
  padding: 0 14px 10px;
  color: var(--ai-composer-danger, var(--status-danger));
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

</style>
