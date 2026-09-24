<template>
  <Popover :open="open" @update:open="$emit('update:open', $event)">
    <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverContent class="repository-file-picker-popover p-0" align="start" :collision-padding="12" :side-offset="6">
      <aside class="repository-file-picker">
        <div class="repository-file-picker-toolbar">
          <label class="repository-file-picker-search" :data-disabled="searchDisabled ? 'true' : undefined">
            <Search :size="13" />
            <input
              :value="search"
              type="search"
              :disabled="searchDisabled"
              :placeholder="searchPlaceholder"
              :aria-label="searchLabel"
              @input="$emit('update:search', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <slot name="actions" />
        </div>
        <ScrollArea type="always" :horizontal="false" class="repository-file-picker-scroll">
          <div class="repository-file-picker-content"><slot /></div>
        </ScrollArea>
      </aside>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";

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
:global([data-reka-popper-content-wrapper] > .repository-file-picker-popover) { width: min(360px, calc(100vw - 24px)); height: min(620px, var(--reka-popover-content-available-height, calc(100vh - 24px))); max-height: var(--reka-popover-content-available-height, calc(100vh - 24px)); border-color: var(--line-subtle); background: var(--surface); color: var(--text); overflow: hidden; }
.repository-file-picker { display: grid; width: 100%; height: 100%; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-file-picker-toolbar { display: flex; min-width: 0; align-items: center; gap: 6px; border-bottom: 1px solid var(--line-subtle); padding: 6px; }
.repository-file-picker-search { display: flex; min-width: 0; min-height: 30px; flex: 1 1 auto; align-items: center; gap: 6px; border: 1px solid var(--line-subtle); border-radius: 5px; background: var(--surface-inset); color: var(--text-muted); padding: 0 8px; }
.repository-file-picker-search:focus-within { border-color: var(--brand-accent); }
.repository-file-picker-search[data-disabled="true"] { opacity: 0.6; }
.repository-file-picker-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 12px; }
.repository-file-picker-scroll { min-width: 0; min-height: 0; }
.repository-file-picker-content { min-width: 0; padding: 4px; }
</style>
