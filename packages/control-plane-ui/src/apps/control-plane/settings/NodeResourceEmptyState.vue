<template>
  <div class="node-resource-empty-state" role="status">
    <component :is="icon" :size="28" :stroke-width="1.6" aria-hidden="true" />
    <p>{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import type { Component } from "vue";

defineProps<{
  icon: Component;
  message: string;
}>();
</script>

<style scoped>
.node-resource-empty-state {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 7px;
  min-height: 96px;
  padding: 14px 16px;
  color: var(--text-muted);
  text-align: center;
}

.node-resource-empty-state > svg {
  opacity: 0.72;
}

.node-resource-empty-state p {
  max-width: 420px;
  margin: 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}
</style>
