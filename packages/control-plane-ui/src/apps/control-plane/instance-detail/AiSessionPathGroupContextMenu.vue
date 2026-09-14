<template>
  <ContextMenu v-if="canCopy || canOpen || canRename">
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent class="ai-session-context-menu">
      <ContextMenuItem v-if="canOpen" class="ai-session-path-group-menu-item" @select="emit('open')">
        <FolderOpen :size="14" />
        <span>{{ t("sessions.panel.openInFileManager") }}</span>
      </ContextMenuItem>
      <ContextMenuItem v-if="canCopy" class="ai-session-path-group-menu-item" @select="emit('copy')">
        <Copy :size="14" />
        <span>{{ t("sessions.actions.copyPath") }}</span>
      </ContextMenuItem>
      <ContextMenuSeparator v-if="canRename && (canCopy || canOpen)" />
      <ContextMenuItem v-if="canRename" class="ai-session-path-group-menu-item" @select="emit('rename')">
        <Pencil :size="14" />
        <span>{{ t("sessions.panel.renameProject") }}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  <slot v-else />
</template>

<script setup lang="ts">
import { Copy, FolderOpen, Pencil } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../../components/ui/context-menu";

defineProps<{
  canCopy: boolean;
  canOpen: boolean;
  canRename: boolean;
}>();

const emit = defineEmits<{
  copy: [];
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
