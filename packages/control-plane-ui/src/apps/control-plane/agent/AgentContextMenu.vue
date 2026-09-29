<template>
  <ContextMenuContent class="ai-session-context-menu">
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!canRun" @select="$emit('run')">
      <Play :size="14" /><span>{{ t("agents.detail.run") }}</span>
    </ContextMenuItem>
    <ContextMenuItem class="ai-session-context-menu-item" :disabled="!editable" @select="$emit('edit')">
      <Pencil :size="14" /><span>{{ t("agents.detail.edit") }}</span>
    </ContextMenuItem>
    <ContextMenuItem v-if="viewDetail" class="ai-session-context-menu-item" :disabled="!viewDetail.enabled" @select="$emit('viewDetail')">
      <FileText :size="14" /><span>{{ t("agents.detail.viewDetail") }}</span>
    </ContextMenuItem>
    <ContextMenuItem v-if="orchestration" class="ai-session-context-menu-item" :disabled="!orchestration.enabled" @select="$emit('orchestration')">
      <Layers :size="14" /><span>{{ t(orchestration.label === "edit" ? "agents.detail.editOrchestration" : "agents.detail.viewOrchestration") }}</span>
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem class="ai-session-context-menu-item danger" :disabled="!editable || deleting" @select="$emit('delete')">
      <Trash2 :size="14" /><span>{{ t("agents.detail.delete") }}</span>
    </ContextMenuItem>
  </ContextMenuContent>
</template>

<script setup lang="ts">
import { FileText, Layers, Pencil, Play, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "../../../components/ui/context-menu";

// Agent 列表行与画布节点共用的操作菜单，控件样式与 Story 列表菜单一致；
// 运行、编辑、删除的可用性由调用方按同一份目录数据判定。
defineProps<{
  canRun: boolean;
  editable: boolean;
  deleting: boolean;
  /**
   * 「查看 Agent 详情」入口：不传表示当前场景不提供（列表行单击即可选中），传值时 enabled 决定可用性。
   * 用对象而不是 boolean：Vue 会把缺省的 boolean prop 强转成 false，"不传 = 不提供" 表达不出来。
   */
  viewDetail?: { enabled: boolean };
  /** 编排入口：不传表示当前场景不提供；列表行用它「编辑编排」，画布节点用它「查看编排」。 */
  orchestration?: { label: "edit" | "view"; enabled: boolean };
}>();

defineEmits<{
  run: [];
  edit: [];
  viewDetail: [];
  orchestration: [];
  delete: [];
}>();

const { t } = useI18n();
</script>
