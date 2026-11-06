<template>
  <div class="repository-file-search-toolbar">
    <label class="repository-file-search" :data-disabled="searchDisabled ? 'true' : undefined">
      <Search :size="13" aria-hidden="true" />
      <Input
        :model-value="search"
        type="search"
        :disabled="searchDisabled"
        :placeholder="searchPlaceholder"
        :aria-label="searchLabel"
        @update:model-value="$emit('update:search', String($event))"
      />
    </label>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Input } from "../../../components/ui/input";

defineProps<{
  search: string;
  searchDisabled?: boolean;
  searchLabel: string;
  searchPlaceholder: string;
}>();
defineEmits<{ "update:search": [value: string] }>();
</script>

<style scoped>
.repository-file-search-toolbar { display: flex; min-width: 0; align-items: center; gap: 6px; border-bottom: 1px solid var(--line-subtle); padding: 6px; }
.repository-file-search { display: flex; min-width: 0; min-height: 30px; flex: 1 1 auto; align-items: center; gap: 6px; border: 1px solid var(--line-subtle); border-radius: 5px; background: var(--surface-inset); color: var(--text-muted); padding: 0 8px; }
.repository-file-search:focus-within { border-color: var(--brand-accent); }
.repository-file-search[data-disabled="true"] { opacity: 0.6; }
.repository-file-search > svg { flex: 0 0 auto; }
.repository-file-search :deep(input) { width: 100%; height: 30px; min-width: 0; border: 0; border-radius: 0; outline: 0; background: transparent; color: var(--text); padding: 0; font: inherit; font-size: 12px; box-shadow: none; }
</style>
