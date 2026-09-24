<template>
  <div class="repository-file-tree" role="tree" :aria-label="label">
    <button
      v-for="node in nodes"
      :key="node.id"
      type="button"
      class="repository-file-tree-row"
      role="treeitem"
      :aria-level="node.depth + 1"
      :aria-expanded="node.expandable ? Boolean(node.expanded) : undefined"
      :aria-selected="node.selectable ? Boolean(node.active) : undefined"
      :data-active="node.active ? 'true' : undefined"
      :data-kind="node.kind"
      :disabled="node.disabled || (!node.expandable && !node.selectable)"
      :style="{ '--repository-tree-depth': node.depth }"
      :title="node.path"
      @click="activate(node)"
    >
      <ChevronRight v-if="node.expandable" class="repository-file-tree-chevron" :class="{ open: node.expanded }" :size="13" />
      <span v-else class="repository-file-tree-spacer" />
      <Folder v-if="node.kind === 'directory'" :size="14" />
      <FileDiff v-else-if="node.icon === 'diff'" :size="14" />
      <FileCode2 v-else-if="node.kind === 'file'" :size="14" />
      <FolderLock v-else-if="node.kind === 'submodule' || node.kind === 'nested-repository'" :size="14" />
      <Link v-else-if="node.kind === 'symlink'" :size="14" />
      <FileWarning v-else :size="14" />
      <span class="repository-file-tree-label">
        <span>{{ node.name }}</span>
        <small v-if="node.description">{{ node.description }}</small>
      </span>
      <span v-if="$slots.trailing" class="repository-file-tree-trailing"><slot name="trailing" :node="node" /></span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { RepositoryDirectoryEntry } from "@task-handoff/protocol/repository";
import { ChevronRight, FileCode2, FileDiff, FileWarning, Folder, FolderLock, Link } from "@lucide/vue";

export type RepositoryFileTreeNode = {
  id: string;
  path: string;
  name: string;
  kind: RepositoryDirectoryEntry["kind"];
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  selectable?: boolean;
  active?: boolean;
  disabled?: boolean;
  description?: string;
  icon?: "file" | "diff";
};

defineProps<{ label: string; nodes: RepositoryFileTreeNode[] }>();
const emit = defineEmits<{ select: [node: RepositoryFileTreeNode]; toggle: [node: RepositoryFileTreeNode] }>();

function activate(node: RepositoryFileTreeNode) {
  if (node.expandable) emit("toggle", node);
  else if (node.selectable) emit("select", node);
}
</script>

<style scoped>
.repository-file-tree { display: grid; min-width: 0; }
.repository-file-tree-row { display: flex; width: 100%; min-height: 31px; align-items: center; gap: 6px; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 3px 6px 3px calc(6px + var(--repository-tree-depth) * 14px); text-align: left; }
.repository-file-tree-row:hover:not(:disabled), .repository-file-tree-row:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-file-tree-row[data-active="true"] { background: color-mix(in srgb, var(--brand-accent) 10%, transparent); color: var(--text); }
.repository-file-tree-row:disabled { cursor: not-allowed; opacity: 0.55; }
.repository-file-tree-row > svg { flex: 0 0 auto; }
.repository-file-tree-label { display: grid; min-width: 0; flex: 1 1 auto; font-size: 12px; font-weight: 400; line-height: 16px; }
.repository-file-tree-label > span, .repository-file-tree-label > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repository-file-tree-label > small { color: var(--text-faint); font-size: 12px; font-weight: 400; }
.repository-file-tree-chevron { transition: transform 120ms ease; }
.repository-file-tree-chevron.open { transform: rotate(90deg); }
.repository-file-tree-spacer { width: 13px; flex: 0 0 13px; }
.repository-file-tree-trailing { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; }
@media (prefers-reduced-motion: reduce) { .repository-file-tree-chevron { transition: none; } }
</style>
