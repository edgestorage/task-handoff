<template>
  <ContextMenuContent class="instance-action-menu">
    <InstanceActionMenuItems
      :active-action-label="activeActionLabel"
      :ai-session-count="aiSessionCount"
      :can-export-config="canExportConfig"
      :instance="instance"
      :is-closing-all-sessions="isClosingAllSessions"
      :is-instance-action-busy="isInstanceActionBusy"
      variant="context"
      @close-all-sessions="emit('command', { type: 'close-all-sessions' })"
      @open-config-sync="(direction) => emit('command', { type: 'open-config-sync', direction })"
      @open-settings="emit('command', { type: 'open-settings' })"
      @open-window="emit('command', { type: 'open-window' })"
      @run-action="(action) => emit('command', { type: 'run-action', action })"
      @save-template="emit('command', { type: 'save-template' })"
    />
  </ContextMenuContent>
</template>

<script setup lang="ts">
import type { InstanceBoardItem } from "../../../api/types";
import { ContextMenuContent } from "../../../components/ui/context-menu";
import type { InstanceAction } from "../useInstanceActions";
import InstanceActionMenuItems from "../instance-list/InstanceActionMenuItems.vue";
import type { InstanceContextMenuCommand } from "./instanceContextMenu";

defineProps<{
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  aiSessionCount: (instance: InstanceBoardItem) => number;
  canExportConfig: (instance: InstanceBoardItem) => boolean;
  instance: InstanceBoardItem;
  isClosingAllSessions: (instance: InstanceBoardItem) => boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
}>();

const emit = defineEmits<{
  command: [command: InstanceContextMenuCommand];
}>();
</script>

<style src="./InstanceActionMenu.css"></style>
