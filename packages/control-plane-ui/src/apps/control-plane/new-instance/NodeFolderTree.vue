<template>
  <div class="node-folder-tree">
    <div class="node-folder-tree-head">
      <span>{{ t("instances.create.folders.title") }}</span>
      <Button variant="outline" size="sm" :disabled="loading" @click="$emit('refresh')">
        <FolderOpen :size="14" />
        <span>{{ loading ? t("instances.create.folders.loading") : t("instances.create.folders.refresh") }}</span>
      </Button>
    </div>
    <div v-if="loading" class="node-folder-tree-empty">{{ t("instances.create.folders.loadingFolders") }}</div>
    <div v-else-if="error" class="node-folder-tree-empty error">{{ error }}</div>
    <ScrollArea v-else-if="rows.length" class="node-folder-tree-list">
      <div class="node-folder-tree-list-content">
        <button
          v-for="folder in rows"
          :key="folder.path"
          type="button"
          class="node-folder-tree-row"
          :class="{ active: selectedPath === folder.path }"
          :style="{ '--folder-depth': folder.depth }"
          @click="$emit('select', folder)"
        >
          <ChevronDown v-if="folder.expanded" :size="14" />
          <ChevronRight v-else-if="folder.loading || !folder.loaded" :size="14" />
          <Folder v-else :size="14" />
          <span>{{ folder.name }}</span>
          <small>{{ folder.path }}</small>
        </button>
      </div>
    </ScrollArea>
    <div v-else class="node-folder-tree-empty">{{ t("instances.create.folders.empty") }}</div>
  </div>
</template>

<script setup lang="ts">
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { NodeFolderTreeNode } from "./nodeFolderTree";

const { t } = useI18n();

defineProps<{
  error: string;
  loading: boolean;
  rows: NodeFolderTreeNode[];
  selectedPath: string;
}>();

defineEmits<{
  refresh: [];
  select: [folder: NodeFolderTreeNode];
}>();
</script>

<style scoped>
.node-folder-tree {
  display: grid;
  gap: 8px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  padding: 9px;
}

.node-folder-tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.node-folder-tree-head span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.node-folder-tree-list {
  max-height: 210px;
}

.node-folder-tree-list-content {
  display: grid;
  gap: 4px;
}

.node-folder-tree-row {
  display: grid;
  grid-template-columns: 16px minmax(90px, 0.7fr) minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--terminal-text);
  cursor: pointer;
  padding: 0 8px 0 calc(8px + (var(--folder-depth) * 16px));
  text-align: left;
}

.node-folder-tree-row:hover,
.node-folder-tree-row:focus-visible,
.node-folder-tree-row.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.node-folder-tree-row svg {
  color: var(--status-success);
}

.node-folder-tree-row span,
.node-folder-tree-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-folder-tree-row span {
  font-size: 12px;
  font-weight: 750;
}

.node-folder-tree-row small,
.node-folder-tree-empty {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.node-folder-tree-empty {
  min-height: 32px;
  align-content: center;
}

.node-folder-tree-empty.error {
  color: var(--status-danger);
}
</style>
