<template>
  <ContextMenu v-if="canOpen || canRename">
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent class="ai-session-context-menu">
      <ContextMenuItem v-if="canOpen" class="ai-session-path-group-menu-item" @select="emit('open')">
        <FolderOpen :size="14" />
        <span>{{ t("sessions.panel.openInFileManager") }}</span>
      </ContextMenuItem>
      <ContextMenuSeparator v-if="canOpen && canRename" />
      <ContextMenuItem v-if="canRename" class="ai-session-path-group-menu-item" @select="emit('rename')">
        <Pencil :size="14" />
        <span>{{ t("sessions.panel.renameProject") }}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  <slot v-else />
</template>

<script setup lang="ts">
import { FolderOpen, Pencil } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../../components/ui/context-menu";

defineProps<{
  canOpen: boolean;
  canRename: boolean;
}>();

const emit = defineEmits<{
  open: [];
  rename: [];
}>();
const { t } = useI18n();
</script>

<style scoped>
:global(.ai-session-context-menu .ai-session-path-group-menu-item) {
  gap: 8px;
  font-size: 13px;
}
</style>
