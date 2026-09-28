<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!canRun" @select="$emit('run')">
      <Play :size="14" /><span>{{ t("agents.detail.run") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!editable" @select="$emit('edit')">
      <Pencil :size="14" /><span>{{ t("agents.detail.edit") }}</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem class="ai-session-context-menu-item danger" :disabled="!editable || deleting" @select="$emit('delete')">
      <Trash2 :size="14" /><span>{{ t("agents.detail.delete") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { Pencil, Play, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "../../../components/ui/context-menu";

// Agent 列表行与画布节点共用的操作菜单，控件样式与 Story 列表菜单一致；
// 运行、编辑、删除的可用性由调用方按同一份目录数据判定。
defineProps<{
  canRun: boolean;
  editable: boolean;
  deleting: boolean;
}>();

defineEmits<{
  run: [];
  edit: [];
  delete: [];
}>();

const { t } = useI18n();
</script>
