<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!canNewSession" @select="$emit('new-session')">
      <MessageSquarePlus :size="14" /><span>{{ t("stories.newSession") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!canAddExisting" @select="$emit('add-existing')">
      <Link :size="14" /><span>{{ t("stories.addExisting") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('edit')">
      <Pencil :size="14" /><span>{{ t("common.actions.edit") }}</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('toggle-archive')">
      <Archive v-if="!story.archivedAt" :size="14" /><RotateCcw v-else :size="14" /><span>{{ t(story.archivedAt ? "common.actions.restore" : "common.actions.archive") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item danger" @select="$emit('delete')">
      <Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { Archive, Link, MessageSquarePlus, Pencil, RotateCcw, Trash2 } from "@lucide/vue";
import type { Story } from "@task-handoff/protocol/stories";
import { useI18n } from "vue-i18n";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "../../../components/ui/context-menu";

defineProps<{
  story: Story;
  canNewSession: boolean;
  canAddExisting: boolean;
}>();

defineEmits<{
  "new-session": [];
  "add-existing": [];
  edit: [];
  "toggle-archive": [];
  delete: [];
}>();

const { t } = useI18n();
</script>
