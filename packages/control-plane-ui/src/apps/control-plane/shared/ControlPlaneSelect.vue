<template>
  <Select v-model="model" :disabled="disabled">
    <SelectTrigger :class="['control-plane-select', triggerClass]" :disabled="disabled">
      <SelectValue :placeholder="placeholder" />
    </SelectTrigger>
    <SelectContent class="control-plane-select-content">
      <slot />
    </SelectContent>
  </Select>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../../../components/ui/select";

defineProps<{
  disabled?: boolean;
  placeholder?: string;
  triggerClass?: HTMLAttributes["class"];
}>();

const model = defineModel<string>({ default: "" });
</script>

<style scoped>
.control-plane-select {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--control-plane-select-border);
  border-radius: 6px;
  background: var(--control-plane-select-bg);
  color: var(--control-plane-select-text);
  font-size: 13px;
  justify-content: space-between;
  padding: 0 9px;
}

.control-plane-select.board-select {
  width: 124px;
  height: 30px;
  min-height: 30px;
  border-color: var(--control-plane-select-board-border);
  background: var(--control-plane-select-board-bg);
  color: var(--control-plane-select-board-text);
  font-size: 12px;
  font-weight: 700;
  box-shadow: none;
}

.control-plane-select.board-select:hover,
.control-plane-select.board-select:focus,
.control-plane-select.board-select[data-state="open"] {
  border-color: var(--control-plane-select-board-hover-border);
  background: var(--control-plane-select-board-hover-bg);
}

.control-plane-select.board-select[data-placeholder] {
  color: var(--control-plane-select-placeholder);
}

.control-plane-select.board-app-select {
  width: 146px;
}

:global(.control-plane-select-content) {
  border: 1px solid var(--control-plane-select-content-border);
  background: var(--control-plane-select-content-bg);
  color: var(--control-plane-select-content-text);
}
</style>
