<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('open')">
      <FileText :size="14" /><span>{{ t("common.actions.open") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" @select="$emit('download')">
      <Download :size="14" /><span>{{ t("common.actions.download") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="disabled" @select="$emit('rename')">
      <Pencil :size="14" /><span>{{ t("common.actions.rename") }}</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem class="ai-session-context-menu-item danger" :disabled="disabled" @select="$emit('delete')">
      <Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { Download, FileText, Pencil, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "../../../components/ui/context-menu";

defineProps<{ disabled: boolean }>();

defineEmits<{
  open: [];
  download: [];
  rename: [];
  delete: [];
}>();

const { t } = useI18n();
</script>
