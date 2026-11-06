<template>
  <Popover :open="open" @update:open="$emit('update:open', $event)">
    <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverContent class="repository-file-picker-popover p-0" align="start" :collision-padding="12" :side-offset="6">
      <aside class="repository-file-picker">
        <RepositoryFileSearchToolbar
          :search="search"
          :search-disabled="searchDisabled"
          :search-label="searchLabel"
          :search-placeholder="searchPlaceholder"
          @update:search="$emit('update:search', $event)"
        >
          <slot name="actions" />
        </RepositoryFileSearchToolbar>
        <ScrollArea type="always" :horizontal="false" class="repository-file-picker-scroll">
          <div class="repository-file-picker-content"><slot /></div>
        </ScrollArea>
      </aside>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import RepositoryFileSearchToolbar from "./RepositoryFileSearchToolbar.vue";

defineProps<{
  open: boolean;
  search: string;
  searchDisabled?: boolean;
  searchLabel: string;
  searchPlaceholder: string;
}>();
defineEmits<{ "update:open": [value: boolean]; "update:search": [value: string] }>();
</script>

<style scoped>
:global([data-reka-popper-content-wrapper] > .repository-file-picker-popover) { width: min(300px, calc(100vw - 24px)); border-color: var(--line-subtle); background: var(--surface); color: var(--text); overflow: hidden; }
.repository-file-picker { display: grid; width: 100%; min-height: 0; max-height: min(400px, var(--reka-popover-content-available-height, calc(100vh - 24px))); grid-template-rows: auto minmax(0, 1fr); }
.repository-file-picker-scroll { min-width: 0; min-height: 0; }
.repository-file-picker-content { min-width: 0; padding: 4px; }
</style>
