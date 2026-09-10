<template>
  <ContextMenuContent class="instance-action-menu workbench-layout-context-menu">
    <slot />
    <ContextMenuSeparator v-if="$slots.default && (showHeaderDensity || showWindowAlwaysOnTop || showStatusBar || showInstanceSidebar)" />
    <ContextMenuLabel v-if="showHeaderDensity" class="workbench-layout-menu-label">{{ t("sessions.tabs.headerDensity") }}</ContextMenuLabel>
    <ContextMenuRadioGroup v-if="showHeaderDensity" :model-value="headerDensity" @update:model-value="setHeaderDensity($event as HeaderDensity)">
      <ContextMenuRadioItem class="instance-action-item workbench-layout-menu-choice" value="compact">
        {{ t("sessions.tabs.headerCompact") }}
      </ContextMenuRadioItem>
      <ContextMenuRadioItem class="instance-action-item workbench-layout-menu-choice" value="normal">
        {{ t("sessions.tabs.headerNormal") }}
      </ContextMenuRadioItem>
    </ContextMenuRadioGroup>
    <ContextMenuSeparator v-if="showHeaderDensity && (showWindowAlwaysOnTop || showStatusBar || showInstanceSidebar)" />
    <ContextMenuCheckboxItem
      v-if="showWindowAlwaysOnTop"
      :model-value="windowAlwaysOnTop"
      class="instance-action-item workbench-layout-menu-check"
      :disabled="windowAlwaysOnTopDisabled"
      @update:model-value="$emit('update:windowAlwaysOnTop', Boolean($event))"
    >
      {{ t("sessions.tabs.alwaysOnTop") }}
    </ContextMenuCheckboxItem>
    <ContextMenuCheckboxItem
      v-if="showStatusBar"
      :model-value="statusBarVisible"
      class="instance-action-item workbench-layout-menu-check"
      @update:model-value="$emit('update:statusBarVisible', Boolean($event))"
    >
      {{ t("sessions.tabs.showStatusBar") }}
    </ContextMenuCheckboxItem>
    <ContextMenuCheckboxItem
      v-if="showInstanceSidebar"
      :model-value="instanceSidebarVisible"
      class="instance-action-item workbench-layout-menu-check"
      @update:model-value="$emit('update:instanceSidebarVisible', Boolean($event))"
    >
      {{ t("sessions.tabs.showInstanceSidebar") }}
    </ContextMenuCheckboxItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "../../../components/ui/context-menu";
import { type HeaderDensity, useWorkbenchLayoutPreferences } from "../useWorkbenchLayoutPreferences";

withDefaults(defineProps<{
  instanceSidebarVisible?: boolean;
  showHeaderDensity?: boolean;
  showInstanceSidebar?: boolean;
  showStatusBar?: boolean;
  showWindowAlwaysOnTop?: boolean;
  statusBarVisible?: boolean;
  windowAlwaysOnTop?: boolean;
  windowAlwaysOnTopDisabled?: boolean;
}>(), {
  instanceSidebarVisible: false,
  showHeaderDensity: true,
  showInstanceSidebar: false,
  showStatusBar: false,
  showWindowAlwaysOnTop: false,
  statusBarVisible: false,
  windowAlwaysOnTop: false,
  windowAlwaysOnTopDisabled: false,
});

defineEmits<{
  "update:instanceSidebarVisible": [visible: boolean];
  "update:statusBarVisible": [visible: boolean];
  "update:windowAlwaysOnTop": [enabled: boolean];
}>();

const { t } = useI18n();
const { headerDensity, setHeaderDensity } = useWorkbenchLayoutPreferences();
</script>

<style>
.instance-action-menu.workbench-layout-context-menu {
  display: grid;
  width: 172px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.workbench-layout-context-menu .instance-action-item {
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
  font-size: 13px;
  font-weight: 500;
  padding: 0 8px;
  text-align: left;
}

.workbench-layout-context-menu .instance-action-item > span:not(:first-child) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-layout-context-menu .workbench-layout-menu-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  padding: 3px 8px 2px;
}

.instance-action-menu.workbench-layout-context-menu .instance-action-item.workbench-layout-menu-choice,
.instance-action-menu.workbench-layout-context-menu .instance-action-item.workbench-layout-menu-check {
  position: relative;
  padding: 0 8px 0 30px;
}

.instance-action-menu.workbench-layout-context-menu .instance-action-item.workbench-layout-menu-choice > span:first-child,
.instance-action-menu.workbench-layout-context-menu .instance-action-item.workbench-layout-menu-check > span:first-child {
  position: absolute;
  left: 8px;
  min-width: 14px;
  width: 14px;
  height: 14px;
  overflow: visible;
}

.instance-action-menu.workbench-layout-context-menu .workbench-layout-menu-choice > span:first-child svg {
  width: 8px;
  height: 8px;
}
</style>
