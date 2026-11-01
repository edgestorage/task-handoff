<template>
  <AiSessionPanel
    v-bind="$attrs"
    :active-action-label="instanceActionMenu.activeActionLabel"
    :active-session="activeSession"
    :can-export-config="instanceActionMenu.canExportConfig"
    :instance="instance"
    :is-closing-all-sessions="instanceActionMenu.isClosingAllSessions"
    :is-instance-action-busy="instanceActionMenu.isInstanceActionBusy"
    :selected-ai-session="selectedAiSession"
    @instance-context-menu-command="forwardCommand"
  />
</template>

<script setup lang="ts">
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
import AiSessionPanel from "../instance-detail/AiSessionPanel.vue";
import type { SessionTab } from "../useInstanceSessions";
import type {
  InstanceActionMenuBindings,
  InstanceContextMenuCommand,
  InstanceContextMenuCommandEvent,
} from "./instanceContextMenu";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  activeSession: SessionTab;
  instance: InstanceWithAiSessions;
  instanceActionMenu: InstanceActionMenuBindings;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
}>();

const emit = defineEmits<{
  instanceContextMenuCommand: [event: InstanceContextMenuCommandEvent];
}>();

function forwardCommand(command: InstanceContextMenuCommand) {
  emit("instanceContextMenuCommand", { command, instance: props.instance });
}
</script>
