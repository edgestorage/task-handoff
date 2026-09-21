<template>
  <DropdownMenu @update:open="resetMenuState">
    <DropdownMenuTrigger as-child>
      <button :id="id" type="button" class="new-worktree-branch-trigger" :disabled="disabled">
        <GitBranch :size="15" />
        <strong>{{ selectedBranch?.name || modelValue || t("sessions.panel.chooseBranch") }}</strong>
        <small v-if="showDetached && selectedBranch?.worktreeCheckout === 'detached'">{{ t("sessions.panel.detached") }}</small>
        <ChevronDown :size="14" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="new-worktree-branch-menu" align="start" :collision-padding="12" :side-offset="6">
      <input v-model="query" class="new-worktree-search" :placeholder="t('sessions.panel.searchBranches')" :aria-label="t('sessions.panel.searchBranches')" />
      <ScrollArea type="auto" :horizontal="false" class="new-worktree-list">
        <DropdownMenuItem
          v-for="node in visibleBranches"
          :key="node.id"
          class="new-worktree-branch-item"
          :class="{ 'is-folder': node.kind === 'folder' }"
          :style="{ paddingInlineStart: `${8 + node.depth * 16}px` }"
          @select="node.kind === 'folder' ? toggleFolder($event, node.id) : emit('update:modelValue', node.branch.name)"
        >
          <template v-if="node.kind === 'folder'">
            <i class="new-worktree-tree-toggle" aria-hidden="true"><ChevronRight :class="{ expanded: node.expanded }" :size="9" /></i>
            <FolderOpen v-if="node.expanded" :size="14" />
            <Folder v-else :size="14" />
            <span>{{ node.label }}</span>
            <small>{{ node.count }}</small>
          </template>
          <template v-else>
            <i class="new-worktree-tree-toggle" aria-hidden="true" />
            <GitBranch :size="14" />
            <span :title="node.branch.name">{{ node.label }}</span>
            <small v-if="showDetached && node.branch.worktreeCheckout === 'detached'">{{ t("sessions.panel.detached") }}</small>
            <Check v-if="modelValue === node.branch.name" :size="15" />
          </template>
        </DropdownMenuItem>
        <p v-if="!visibleBranches.length" class="new-worktree-empty">{{ t("sessions.panel.noBranches") }}</p>
      </ScrollArea>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, GitBranch } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";

export type NewWorktreeBranch = {
  name: string;
  worktreeCheckout: "attached" | "detached";
  worktreeSelectable: boolean;
};

type BranchTreeFolder = { children: BranchTreeNode[]; id: string; kind: "folder"; label: string };
type BranchTreeLeaf = { branch: NewWorktreeBranch; id: string; kind: "branch"; label: string };
type BranchTreeNode = BranchTreeFolder | BranchTreeLeaf;
type VisibleBranchTreeNode =
  | { count: number; depth: number; expanded: boolean; id: string; kind: "folder"; label: string }
  | { branch: NewWorktreeBranch; depth: number; id: string; kind: "branch"; label: string };

const props = withDefaults(defineProps<{
  branches: NewWorktreeBranch[];
  disabled?: boolean;
  id: string;
  modelValue: string;
  selectableOnly?: boolean;
  showDetached?: boolean;
}>(), {
  disabled: false,
  selectableOnly: false,
  showDetached: false,
});
const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();
const { t } = useI18n();
const query = ref("");
const collapsedFolders = ref(new Set<string>());

const selectedBranch = computed(() => props.branches.find((branch) => branch.name === props.modelValue));
const filteredBranches = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase();
  return props.branches.filter((branch) => (!props.selectableOnly || branch.worktreeSelectable)
    && (!normalized || branch.name.toLocaleLowerCase().includes(normalized)));
});
const branchTree = computed(() => buildBranchTree(filteredBranches.value));
const visibleBranches = computed(() => flattenBranchTree(branchTree.value, Boolean(query.value.trim())));

watch(() => props.modelValue, () => {
  query.value = "";
});

function resetMenuState(open: boolean) {
  if (!open) return;
  query.value = "";
  collapsedFolders.value = new Set();
}

function buildBranchTree(branches: NewWorktreeBranch[]): BranchTreeNode[] {
  // i18n-audit-allow-next-line code-token: internal Git branch tree root identifier
  const root: BranchTreeFolder = { children: [], id: "branch", kind: "folder", label: "branch" };
  for (const branch of branches) {
    const parts = branch.name.split("/").filter(Boolean);
    let parent = root;
    for (const [index, part] of parts.entries()) {
      const id = `branch:${parts.slice(0, index + 1).join("/")}`;
      if (index === parts.length - 1) {
        parent.children.push({ branch, id: `${id}:leaf`, kind: "branch", label: part });
        continue;
      }
      let folder = parent.children.find((node): node is BranchTreeFolder => node.kind === "folder" && node.label === part);
      if (!folder) {
        folder = { children: [], id, kind: "folder", label: part };
        parent.children.push(folder);
      }
      parent = folder;
    }
  }
  return root.children;
}

function flattenBranchTree(nodes: BranchTreeNode[], forceExpanded: boolean, depth = 0): VisibleBranchTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "branch") return [{ ...node, depth }];
    const expanded = forceExpanded || !collapsedFolders.value.has(node.id);
    return [
      { count: countBranchLeaves(node), depth, expanded, id: node.id, kind: "folder" as const, label: node.label },
      ...(expanded ? flattenBranchTree(node.children, forceExpanded, depth + 1) : []),
    ];
  });
}

function countBranchLeaves(folder: BranchTreeFolder): number {
  return folder.children.reduce((count, node) => count + (node.kind === "branch" ? 1 : countBranchLeaves(node)), 0);
}

function toggleFolder(event: Event, id: string) {
  event.preventDefault();
  const next = new Set(collapsedFolders.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedFolders.value = next;
}
</script>

<style scoped>
.new-worktree-branch-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  padding: 0 10px;
  text-align: left;
}

.new-worktree-branch-trigger:hover,
.new-worktree-branch-trigger:focus-visible,
.new-worktree-branch-trigger[data-state="open"] { border-color: var(--focus-ring); outline: none; }
.new-worktree-branch-trigger > strong { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.new-worktree-branch-trigger > small { color: var(--text-muted); font-size: 12px; font-weight: 400; }

:global(.new-worktree-branch-menu) {
  display: grid;
  width: min(420px, var(--reka-dropdown-menu-content-available-width, calc(100vw - 24px)));
  max-height: var(--reka-dropdown-menu-content-available-height);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.new-worktree-list { min-height: 0; overscroll-behavior: contain; }
.new-worktree-list :deep([data-task-handoff-scroll-viewport]) { padding-right: 8px; }
.new-worktree-search { width: 100%; height: 32px; border: 0; border-bottom: 1px solid var(--line); outline: none; background: transparent; color: var(--control-plane-menu-text); padding: 0 8px; font-size: 12px; }
.new-worktree-search::placeholder { color: var(--text-muted); }
.new-worktree-empty { display: grid; min-height: 72px; place-items: center; margin: 0; color: color-mix(in srgb, var(--text-muted) 72%, transparent); font-size: 12px; font-weight: 400; text-align: center; }

:global(.new-worktree-branch-item) { display: flex; min-height: 30px; align-items: center; gap: 6px; border-radius: 6px; color: var(--control-plane-menu-text); font-size: 12px; font-weight: 500; line-height: 1; padding: 0 8px; }
:global(.new-worktree-branch-item > span) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:global(.new-worktree-branch-item > svg) { width: 13px; height: 13px; }
:global(.new-worktree-branch-item.is-folder) { color: var(--text-muted); }
:global(.new-worktree-branch-item small) { margin-left: auto; color: var(--text-muted); font-size: 12px; font-weight: 400; }
:global(.new-worktree-branch-item:hover),
:global(.new-worktree-branch-item:focus-visible),
:global(.new-worktree-branch-item[data-highlighted]) { background: var(--surface-active); color: var(--control-plane-menu-hover-text); outline: none; }
.new-worktree-tree-toggle { display: grid; flex: 0 0 9px; width: 9px; height: 13px; place-items: center; }
.new-worktree-tree-toggle > svg { width: 9px; height: 9px; transition: transform 120ms ease; }
.new-worktree-tree-toggle > svg.expanded { transform: rotate(90deg); }
</style>
