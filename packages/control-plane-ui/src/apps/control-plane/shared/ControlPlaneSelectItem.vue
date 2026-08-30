<template>
  <SelectItem class="control-plane-select-item" :value="value" :disabled="disabled">
    <slot />
  </SelectItem>
</template>

<script setup lang="ts">
import { SelectItem } from "../../../components/ui/select";

defineProps<{
  value: string;
  disabled?: boolean;
}>();
</script>

<style scoped>
:global(.control-plane-select-item) {
  cursor: default;
  color: var(--control-plane-select-content-text);
  font-size: 13px;
}

:global(.control-plane-select-item:hover),
:global(.control-plane-select-item:focus-visible),
:global(.control-plane-select-item[data-highlighted]) {
  background: var(--control-plane-select-item-highlight-bg);
  color: var(--control-plane-select-item-highlight-text);
  outline: none;
}
</style>
