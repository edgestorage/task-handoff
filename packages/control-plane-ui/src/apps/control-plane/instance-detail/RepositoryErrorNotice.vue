<template>
  <div class="repository-error-notice" role="alert">
    <CircleAlert :size="15" />
    <span>
      <span class="repository-error-title"><strong>{{ presentation.message }}</strong><code v-if="presentation.code">{{ presentation.code }}</code><em v-if="presentation.retryable !== undefined">{{ presentation.retryable ? "Retryable" : "Action required" }}</em></span>
      <small v-if="presentation.recovery">{{ presentation.recovery }}</small>
    </span>
  </div>
</template>

<script setup lang="ts">
import { CircleAlert } from "@lucide/vue";
import { computed } from "vue";
import { repositoryErrorPresentation } from "./repositoryErrorPresentation";

const props = defineProps<{
  error: unknown;
  fallback: string;
}>();

const presentation = computed(() => repositoryErrorPresentation(props.error, props.fallback));
</script>

<style scoped>
.repository-error-notice { display: flex; align-items: flex-start; gap: 8px; border: 1px solid color-mix(in srgb, var(--status-danger) 28%, var(--line-subtle)); border-radius: 7px; background: var(--status-danger-bg); color: var(--status-danger); padding: 9px; font-size: 10px; line-height: 1.4; }
.repository-error-notice > span { display: grid; min-width: 0; gap: 4px; }
.repository-error-title { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; gap: 5px; }
.repository-error-title strong { color: inherit; font-size: 10px; overflow-wrap: anywhere; }
.repository-error-title code { border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); padding: 1px 4px; font-size: 8px; }
.repository-error-title em { color: var(--text-muted); font-size: 8px; font-style: normal; text-transform: uppercase; }
.repository-error-notice small { color: color-mix(in srgb, currentColor 78%, var(--text-muted)); font-size: 9px; }
</style>
