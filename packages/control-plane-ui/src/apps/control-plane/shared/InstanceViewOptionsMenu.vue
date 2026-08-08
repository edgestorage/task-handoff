<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm" class="instance-view-options-trigger" :aria-label="label || t('instances.viewOptions.label')" :title="label || t('instances.viewOptions.label')">
        <SlidersHorizontal :size="16" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="instance-view-options-menu" align="end" :side-offset="6">
      <DropdownMenuLabel class="instance-view-options-label">{{ t("instances.viewOptions.sort") }}</DropdownMenuLabel>
      <DropdownMenuRadioGroup :model-value="sortMode" @update:model-value="(value) => $emit('update:sortMode', value as InstanceListSortMode)">
        <DropdownMenuRadioItem class="instance-view-options-item option-item" value="name-asc">{{ t("instances.viewOptions.name") }}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem class="instance-view-options-item option-item" value="node-asc">{{ t("instances.viewOptions.node") }}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem class="instance-view-options-item option-item" value="status-asc">{{ t("instances.viewOptions.status") }}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator class="instance-view-options-separator" />
      <DropdownMenuCheckboxItem class="instance-view-options-item option-item" :model-value="groupByNode" @update:model-value="(value) => $emit('update:groupByNode', Boolean(value))">
        {{ t("instances.viewOptions.groupByNode") }}
      </DropdownMenuCheckboxItem>
      <template v-if="showPreviewInteraction">
        <DropdownMenuSeparator class="instance-view-options-separator" />
        <DropdownMenuLabel class="instance-view-options-label">{{ t("instances.viewOptions.interaction") }}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem class="instance-view-options-item option-item" :model-value="previewInteractive" @update:model-value="(value) => $emit('update:previewInteractive', Boolean(value))">
          {{ t("instances.viewOptions.interactWithPreviews") }}
        </DropdownMenuCheckboxItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { SlidersHorizontal } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import type { InstanceListSortMode } from "../instance-list/useWorkbenchInstances";

const { t } = useI18n();

withDefaults(
  defineProps<{
    groupByNode: boolean;
    label?: string;
    previewInteractive?: boolean;
    showPreviewInteraction?: boolean;
    sortMode: InstanceListSortMode;
  }>(),
  {
    label: undefined,
    previewInteractive: false,
    showPreviewInteraction: false,
  },
);

defineEmits<{
  "update:groupByNode": [value: boolean];
  "update:previewInteractive": [value: boolean];
  "update:sortMode": [value: InstanceListSortMode];
}>();
</script>

<style scoped>
.instance-view-options-trigger {
  width: 30px;
  height: 30px;
  min-height: 0;
  border-color: var(--control-plane-icon-button-border);
  border-radius: 7px;
  background: var(--control-plane-icon-button-bg);
  color: var(--control-plane-icon-button-text);
  padding: 0;
}

.instance-view-options-trigger :deep(svg) {
  width: 15px;
  height: 15px;
}

.instance-view-options-trigger:hover,
.instance-view-options-trigger:focus-visible,
.instance-view-options-trigger[data-state="open"] {
  border-color: var(--control-plane-icon-button-hover-border);
  background: var(--control-plane-icon-button-hover-bg);
  color: var(--control-plane-icon-button-hover-text);
}

.instance-view-options-menu {
  display: grid;
  width: 176px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.instance-view-options-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  line-height: 1;
  padding: 7px 8px 5px;
}

.instance-view-options-separator {
  margin: 4px -5px;
  background: var(--surface-active);
}

.instance-view-options-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--control-plane-menu-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 8px;
  text-align: left;
}

.instance-view-options-item:hover,
.instance-view-options-item:focus-visible,
.instance-view-options-item[data-highlighted],
.instance-view-options-item[data-state="open"] {
  background: var(--surface-active);
  color: var(--control-plane-menu-hover-text);
  outline: none;
}

.option-item {
  padding-left: 28px;
}

.option-item :deep(.absolute) {
  left: 8px;
  width: 12px;
  height: 12px;
}

.option-item :deep(svg) {
  width: 9px;
  height: 9px;
}
</style>
