<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm" class="agent-view-switcher" :aria-label="t('agents.viewMode.label')" :title="t('agents.viewMode.label')">
        <FileText v-if="mode === 'detail'" :size="14" />
        <Layers v-else :size="14" />
        <span>{{ t(mode === "detail" ? "agents.viewMode.detail" : "agents.viewMode.graph") }}</span>
        <ChevronsUpDown :size="13" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="agent-view-switcher-menu" align="start" :side-offset="6" :collision-padding="12">
      <div class="agent-view-switcher-pinned">
        <DropdownMenuRadioGroup :model-value="mode === 'detail' ? DETAIL_ITEM : ''" @update:model-value="selectDetail">
          <DropdownMenuRadioItem :value="DETAIL_ITEM" class="agent-view-switcher-item">
            <span class="agent-view-switcher-name">{{ t("agents.viewMode.detail") }}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </div>
      <DropdownMenuSeparator class="agent-view-switcher-separator" />
      <div class="agent-view-switcher-list">
        <template v-for="group in groups" :key="group.key">
          <DropdownMenuRadioGroup :model-value="mode === 'graph' ? activeKey : ''" @update:model-value="selectOrchestration">
            <DropdownMenuLabel class="agent-view-switcher-label">
              {{ t(group.key === "entry" ? "agents.graph.scope.entry" : "agents.graph.scope.participating") }}
            </DropdownMenuLabel>
            <DropdownMenuRadioItem v-for="orchestration in group.orchestrations" :key="orchestration.key" :value="orchestration.key" class="agent-view-switcher-item">
              <span class="agent-view-switcher-name">{{ orchestration.name }}</span>
              <span v-if="orchestration.isDefault" class="agent-view-switcher-note">{{ t("agents.graph.defaultBadge") }}</span>
              <span v-if="draftCount(orchestration.key)" class="agent-view-switcher-pending" :title="t('agents.graph.dirty', { count: draftCount(orchestration.key) })" />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </template>
        <p v-if="!groups.length" class="agent-view-switcher-empty">{{ t("agents.graph.orchestrationEmpty") }}</p>
      </div>
      <DropdownMenuSeparator class="agent-view-switcher-separator" />
      <DropdownMenuItem class="agent-view-switcher-create" :disabled="!canCreate" @select="emit('create')">
        <Plus :size="14" />
        <span>{{ t("agents.graph.createOrchestration") }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
// 内容选择器：同一个下拉一次回答「现在看什么」——Agent 详情，或它的某张编排。
// 详情固定在顶部，编排按「作为入口 / 参与」分组滚动，新建入口固定在底部。
import { ChevronsUpDown, FileText, Layers, Plus } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AgentOrchestrationGroup } from "./agentCatalog";

/** 详情项的 radio 值：编排 key 由 nodeId 与编排 id 组成，不会与这个保留值冲突。 */
const DETAIL_ITEM = "__detail__";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  mode: "detail" | "graph";
  /** 画布当前编排；详情模式下只用于标记上一次看过的编排。 */
  activeKey?: string;
  /** 分组与顺序由目录层统一给出，选择器只负责画出「入口 / 参与」两个分组标题。 */
  groups: AgentOrchestrationGroup[];
  /** 各编排的未保存改动数，画布卸载后草稿即失效，因此详情模式传空表。 */
  draftCounts?: Record<string, number>;
  canCreate?: boolean;
}>(), {
  activeKey: "",
  draftCounts: () => ({}),
  canCreate: false,
});

const emit = defineEmits<{
  "select-detail": [];
  "select-orchestration": [key: string];
  create: [];
}>();

function draftCount(key: string) {
  return props.draftCounts[key] ?? 0;
}

function selectDetail(value: unknown) {
  if (value !== DETAIL_ITEM) return;
  emit("select-detail");
}

function selectOrchestration(value: unknown) {
  if (typeof value !== "string" || value === DETAIL_ITEM) return;
  emit("select-orchestration", value);
}
</script>

<style scoped>
.agent-view-switcher { flex:none; gap:6px; }
/* 菜单是「固定详情 + 可滚动编排列表 + 固定新建入口」三段：只有列表滚动，首尾入口不随列表溢出。 */
:global(.agent-view-switcher-menu.agent-view-switcher-menu) { display:flex; flex-direction:column; width:min(300px,var(--reka-dropdown-menu-content-available-width)); max-height:min(360px,var(--reka-dropdown-menu-content-available-height)); overflow:hidden; border-color:var(--line-strong); padding:4px; }
:global(.agent-view-switcher-menu .agent-view-switcher-pinned) { flex:none; }
:global(.agent-view-switcher-menu .agent-view-switcher-list) { display:grid; align-content:start; gap:2px; min-height:0; overflow-y:auto; }
:global(.agent-view-switcher-menu .agent-view-switcher-separator) { flex:none; margin:4px -4px; background:var(--line); }
:global(.agent-view-switcher-menu .agent-view-switcher-create.agent-view-switcher-create) { flex:none; }
:global(.agent-view-switcher-menu .agent-view-switcher-label) { color:var(--text-muted); font-size:12px; font-weight:400; padding:8px 8px 4px; }
:global(.agent-view-switcher-menu .agent-view-switcher-item) { width:100%; min-width:0; gap:8px; cursor:pointer; font-size:13px; }
:global(.agent-view-switcher-menu .agent-view-switcher-name) { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
:global(.agent-view-switcher-menu .agent-view-switcher-note) { flex:0 0 auto; color:var(--text-muted); font-size:12px; font-weight:400; }
:global(.agent-view-switcher-menu .agent-view-switcher-pending) { flex:0 0 auto; width:6px; height:6px; border-radius:999px; background:var(--brand-accent); }
:global(.agent-view-switcher-menu .agent-view-switcher-empty) { margin:0; padding:12px; color:var(--text-muted); font-size:12px; text-align:center; }
</style>
