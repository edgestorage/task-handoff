<template>
  <section class="repository-branches-panel" :aria-label="t('repository.branchesPanel.region')">
    <header>
      <span><GitBranch :size="16" /><strong>{{ t("repository.branches") }}</strong></span>
      <span class="repository-branch-header-actions">
        <button type="button" :aria-label="t('repository.branchesPanel.create')" :title="t('repository.branchesPanel.create')" :aria-expanded="createOpen" @click="toggleCreate">
          <X v-if="createOpen" :size="14" />
          <Plus v-else :size="14" />
        </button>
        <button type="button" :aria-label="t('repository.branchesPanel.refresh')" :title="t('repository.branchesPanel.refresh')" :disabled="branchesQuery.isFetching.value" @click="branchesQuery.refetch()">
          <LoaderCircle v-if="branchesQuery.isFetching.value" class="repository-branch-spin" :size="14" />
          <RefreshCw v-else :size="14" />
        </button>
      </span>
    </header>

    <form v-if="createOpen" class="repository-branch-create" @submit.prevent="createBranch">
      <label>
        <span>{{ t("repository.branchesPanel.newFromHead") }}</span>
        <!-- i18n-audit-allow-next-line code-token: example Git branch name -->
        <input v-model="createName" name="branchName" autocomplete="off" placeholder="feature/my-change" :disabled="mutating" />
      </label>
      <button type="submit" :disabled="mutating || !branches?.snapshotId || !createName.trim()">
        <LoaderCircle v-if="mutationAction === 'create'" class="repository-branch-spin" :size="14" />
        <GitBranch v-else :size="14" />
        <span>{{ t("repository.branchesPanel.createCheckout") }}</span>
      </button>
    </form>

    <label class="repository-branch-search">
      <Search :size="14" />
      <input v-model="search" type="search" :placeholder="t('repository.branchesPanel.search')" :aria-label="t('repository.branchesPanel.search')" />
    </label>

    <RepositoryErrorNotice v-if="mutationError" :error="mutationError" :fallback="t('repository.errors.branchOperation')" />
    <div v-if="branchesQuery.isPending.value" class="repository-branch-state" role="status">
      <LoaderCircle class="repository-branch-spin" :size="17" /><span>{{ t("repository.branchesPanel.reading") }}</span>
    </div>
    <RepositoryErrorNotice v-else-if="branchesQuery.error.value" :error="branchesQuery.error.value" :fallback="t('repository.errors.branchesLoad')" />
    <div v-else class="repository-branch-groups">
      <section>
        <h3>{{ t("repository.branchesPanel.local") }} <span>{{ filteredLocal.length }}</span></h3>
        <div v-if="!filteredLocal.length" class="repository-branch-empty">{{ t("repository.branchesPanel.noLocal") }}</div>
        <template v-for="node in visibleLocal" :key="node.id">
          <button
            v-if="node.kind === 'folder'"
            type="button"
            class="repository-branch-folder"
            :style="branchTreeLayout(node.depth)"
            :aria-label="t('repository.branchesPanel.folder', { name: node.label, count: node.count })"
            :aria-expanded="node.expanded"
            @click="toggleFolder(node.id)"
          >
            <ChevronRight :class="{ expanded: node.expanded }" :size="13" />
            <FolderOpen v-if="node.expanded" :size="14" />
            <Folder v-else :size="14" />
            <strong>{{ node.label }}</strong>
            <span class="repository-branch-folder-count">{{ node.count }}</span>
          </button>
          <article v-else class="repository-branch-row" :data-current="node.branch.current ? 'true' : undefined" :style="branchTreeLayout(node.depth)">
            <button type="button" class="repository-branch-select" :disabled="node.branch.current || mutating" @click="checkoutBranch(node.branch)">
              <span class="repository-branch-name" :title="node.branch.name"><Check v-if="node.branch.current" :size="14" /><GitBranch v-else :size="14" /><span>{{ node.label }}</span></span>
              <small v-if="node.branch.current && currentChangeCount">{{ t("repository.branchesPanel.uncommitted", { count: currentChangeCount }) }}</small>
              <small v-else-if="node.branch.checkedOutWorktreeIds.length">{{ t("repository.branchesPanel.checkedOut", { count: node.branch.checkedOutWorktreeIds.length }) }}</small>
              <small v-else-if="node.branch.upstream">{{ node.branch.upstream }}<template v-if="node.branch.ahead || node.branch.behind"> · {{ t("repository.branchesPanel.sync", { ahead: node.branch.ahead || 0, behind: node.branch.behind || 0 }) }}</template></small>
            </button>
            <button
              v-if="!node.branch.current"
              type="button"
              class="repository-branch-delete"
              :aria-label="t('repository.branchesPanel.delete')"
              :title="t('repository.branchesPanel.delete')"
              :disabled="mutating || node.branch.checkedOutWorktreeIds.length > 0"
              @click="confirmDelete(node.branch)"
            >
              <Trash2 :size="13" />
            </button>
          </article>
        </template>
      </section>

      <section>
        <h3>{{ t("repository.branchesPanel.remote") }} <span>{{ filteredRemote.length }}</span></h3>
        <div v-if="!filteredRemote.length" class="repository-branch-empty">{{ t("repository.branchesPanel.noRemote") }}</div>
        <template v-for="node in visibleRemote" :key="node.id">
          <button
            v-if="node.kind === 'folder'"
            type="button"
            class="repository-branch-folder"
            :style="branchTreeLayout(node.depth)"
            :aria-label="t('repository.branchesPanel.folder', { name: node.label, count: node.count })"
            :aria-expanded="node.expanded"
            @click="toggleFolder(node.id)"
          >
            <ChevronRight :class="{ expanded: node.expanded }" :size="13" />
            <FolderOpen v-if="node.expanded" :size="14" />
            <Folder v-else :size="14" />
            <strong>{{ node.label }}</strong>
            <span class="repository-branch-folder-count">{{ node.count }}</span>
          </button>
          <article v-else class="repository-branch-row remote" :style="branchTreeLayout(node.depth)">
            <div class="repository-branch-select static">
              <span class="repository-branch-name" :title="node.branch.name"><Cloud :size="14" /><span>{{ node.label }}</span></span>
              <small v-if="node.branch.checkedOutWorktreeIds.length">{{ t("repository.branchesPanel.tracked", { count: node.branch.checkedOutWorktreeIds.length }) }}</small>
            </div>
            <button type="button" class="repository-branch-track" :disabled="mutating" @click="beginTracking(node.branch)">{{ t("repository.branchesPanel.track") }}</button>
          </article>
        </template>
      </section>
    </div>

    <Dialog v-model:open="trackingDialogOpen">
      <DialogContent class="repository-branch-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("repository.branchesPanel.trackingTitle") }}</DialogTitle>
          <DialogDescription>{{ t("repository.branchesPanel.trackingDescription", { branch: trackingTarget?.name }) }}</DialogDescription>
        </DialogHeader>
        <label class="repository-branch-dialog-field">
          <span>{{ t("repository.branchesPanel.localName") }}</span>
          <input v-model="trackingName" autocomplete="off" :disabled="mutating" />
        </label>
        <RepositoryErrorNotice v-if="mutationError" :error="mutationError" :fallback="t('repository.branchesPanel.trackingError')" />
        <DialogFooter>
          <Button variant="outline" :disabled="mutating" @click="trackingDialogOpen = false">{{ t("repository.common.cancel") }}</Button>
          <Button :disabled="mutating || !trackingName.trim()" @click="createTrackingBranch">
            <LoaderCircle v-if="mutationAction === 'tracking'" class="repository-branch-spin" :size="14" />
            <GitBranch v-else :size="14" />
            <span>{{ t("repository.branchesPanel.createCheckout") }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="deleteDialogOpen">
      <DialogContent class="repository-branch-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("repository.branchesPanel.deleteTitle") }}</DialogTitle>
          <DialogDescription>{{ t("repository.branchesPanel.deleteDescription") }}</DialogDescription>
        </DialogHeader>
        <div v-if="deleteTarget" class="repository-branch-delete-summary"><GitBranch :size="15" /><strong>{{ deleteTarget.name }}</strong></div>
        <RepositoryErrorNotice v-if="mutationError" :error="mutationError" :fallback="t('repository.branchesPanel.deleteError')" />
        <DialogFooter>
          <Button variant="outline" :disabled="mutating" @click="deleteDialogOpen = false">{{ t("repository.common.cancel") }}</Button>
          <Button variant="destructive" :disabled="mutating || !deleteTarget" @click="deleteBranch">
            <LoaderCircle v-if="mutationAction === 'delete'" class="repository-branch-spin" :size="14" />
            <Trash2 v-else :size="14" />
            <span>{{ t("repository.branchesPanel.delete") }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import type { RepositoryBranch, RepositoryBranchMutationResult, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { Check, ChevronRight, Cloud, Folder, FolderOpen, GitBranch, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  checkoutRepositoryBranch,
  createRepositoryBranch,
  createRepositoryTrackingBranch,
  deleteRepositoryBranch,
  useRepositoryBranchesQuery,
} from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  currentChangeCount: number;
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>();
const { t } = useI18n();

const target = computed(() => ({ instanceId: props.instanceId, sessionKind: props.sessionKind, sessionId: props.sessionId }));
const queryClient = useQueryClient();
const branchesQuery = useRepositoryBranchesQuery(target, computed(() => props.open));
const branches = computed(() => branchesQuery.data.value);
const search = ref("");
const normalizedSearch = computed(() => search.value.trim().toLowerCase());
const filteredLocal = computed(() => (branches.value?.branches || []).filter((branch) => branch.kind === "local" && matchesSearch(branch)));
const filteredRemote = computed(() => (branches.value?.branches || []).filter((branch) => branch.kind === "remote-tracking" && matchesSearch(branch)));
type BranchTreeFolder = { children: BranchTreeNode[]; id: string; kind: "folder"; label: string };
type BranchTreeLeaf = { branch: RepositoryBranch; id: string; kind: "branch"; label: string };
type BranchTreeNode = BranchTreeFolder | BranchTreeLeaf;
type VisibleBranchTreeNode =
  | { count: number; depth: number; expanded: boolean; id: string; kind: "folder"; label: string }
  | { branch: RepositoryBranch; depth: number; id: string; kind: "branch"; label: string };
const collapsedFolders = ref(new Set<string>());
const localTree = computed(() => buildBranchTree(filteredLocal.value, "local"));
const remoteTree = computed(() => buildBranchTree(filteredRemote.value, "remote"));
const visibleLocal = computed(() => flattenBranchTree(localTree.value));
const visibleRemote = computed(() => flattenBranchTree(remoteTree.value));
const createOpen = ref(false);
const createName = ref("");
const trackingDialogOpen = ref(false);
const trackingTarget = ref<RepositoryBranch>();
const trackingName = ref("");
const deleteDialogOpen = ref(false);
const deleteTarget = ref<RepositoryBranch>();
const mutationAction = ref<"" | "create" | "checkout" | "tracking" | "delete">("");
const mutating = computed(() => Boolean(mutationAction.value));
const mutationError = ref<unknown>();

function matchesSearch(branch: RepositoryBranch) {
  return !normalizedSearch.value || branch.name.toLowerCase().includes(normalizedSearch.value);
}

function buildBranchTree(source: RepositoryBranch[], scope: string): BranchTreeNode[] {
  const root: BranchTreeFolder = { children: [], id: scope, kind: "folder", label: scope };
  for (const branch of source) {
    const parts = branch.name.split("/").filter(Boolean);
    let parent = root;
    for (const [index, part] of parts.entries()) {
      const isLeaf = index === parts.length - 1;
      const id = `${scope}:${parts.slice(0, index + 1).join("/")}`;
      if (isLeaf) {
        parent.children.push({ branch, id: `${id}:branch`, kind: "branch", label: part });
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

function flattenBranchTree(nodes: BranchTreeNode[], depth = 0): VisibleBranchTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "branch") return [{ ...node, depth }];
    const expanded = Boolean(normalizedSearch.value) || !collapsedFolders.value.has(node.id);
    return [
      { count: countBranchLeaves(node), depth, expanded, id: node.id, kind: "folder" as const, label: node.label },
      ...(expanded ? flattenBranchTree(node.children, depth + 1) : []),
    ];
  });
}

function countBranchLeaves(folder: BranchTreeFolder): number {
  return folder.children.reduce((count, node) => count + (node.kind === "branch" ? 1 : countBranchLeaves(node)), 0);
}

function toggleFolder(id: string) {
  const next = new Set(collapsedFolders.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedFolders.value = next;
}

function branchTreeLayout(depth: number) {
  const inset = 2 + depth * 18;
  return { marginInlineStart: `${inset}px`, width: `calc(100% - ${inset + 2}px)` };
}

function toggleCreate() {
  createOpen.value = !createOpen.value;
  mutationError.value = undefined;
}

async function applyMutation(action: typeof mutationAction.value, operation: () => Promise<RepositoryBranchMutationResult>) {
  if (!action || mutating.value) return;
  mutationAction.value = action;
  mutationError.value = undefined;
  try {
    const result = await operation();
    queryClient.setQueryData(["repository-branches", props.instanceId, props.sessionKind, props.sessionId], result.branches);
    queryClient.setQueryData(["repository-context", props.instanceId, props.sessionKind, props.sessionId], result.context);
    return result;
  } catch (error) {
    mutationError.value = error;
    await branchesQuery.refetch();
  } finally {
    mutationAction.value = "";
  }
}

async function createBranch() {
  const name = createName.value.trim();
  if (!name || !branches.value?.snapshotId) return;
  const result = await applyMutation("create", () => createRepositoryBranch(target.value, { name, expectedSnapshotId: branches.value!.snapshotId }));
  if (result) {
    createName.value = "";
    createOpen.value = false;
  }
}

async function checkoutBranch(branch: RepositoryBranch) {
  if (branch.current || !branches.value?.snapshotId) return;
  await applyMutation("checkout", () => checkoutRepositoryBranch(target.value, { branch: branch.name, expectedSnapshotId: branches.value!.snapshotId }));
}

function beginTracking(branch: RepositoryBranch) {
  trackingTarget.value = branch;
  trackingName.value = branch.name.includes("/") ? branch.name.slice(branch.name.indexOf("/") + 1) : branch.name;
  mutationError.value = undefined;
  trackingDialogOpen.value = true;
}

async function createTrackingBranch() {
  const name = trackingName.value.trim();
  if (!name || !trackingTarget.value || !branches.value?.snapshotId) return;
  const result = await applyMutation("tracking", () => createRepositoryTrackingBranch(target.value, {
    name,
    remoteTrackingRef: trackingTarget.value!.name,
    expectedSnapshotId: branches.value!.snapshotId,
  }));
  if (result) trackingDialogOpen.value = false;
}

function confirmDelete(branch: RepositoryBranch) {
  if (branch.current || branch.checkedOutWorktreeIds.length) return;
  deleteTarget.value = branch;
  mutationError.value = undefined;
  deleteDialogOpen.value = true;
}

async function deleteBranch() {
  if (!deleteTarget.value || !branches.value?.snapshotId) return;
  const result = await applyMutation("delete", () => deleteRepositoryBranch(target.value, {
    name: deleteTarget.value!.name,
    expectedSnapshotId: branches.value!.snapshotId,
    confirm: true,
  }));
  if (result) {
    deleteDialogOpen.value = false;
    deleteTarget.value = undefined;
  }
}
</script>

<style scoped>
.repository-branches-panel { display: flex; max-height: min(650px, calc(100vh - 32px)); flex-direction: column; overflow: hidden; }
.repository-branches-panel > header,
.repository-branches-panel > header > span,
.repository-branch-header-actions,
.repository-branch-search,
.repository-branch-row,
.repository-branch-name,
.repository-branch-error,
.repository-branch-state,
.repository-branch-delete-summary { display: flex; align-items: center; }
.repository-branches-panel > header { justify-content: space-between; padding: 3px 3px 9px 7px; }
.repository-branches-panel > header > span { gap: 8px; }
.repository-branches-panel > header strong { font-size: 13px; }
.repository-branch-header-actions { gap: 3px; }
.repository-branch-header-actions button { display: grid; width: 27px; height: 27px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.repository-branch-header-actions button:hover:not(:disabled), .repository-branch-header-actions button:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-branch-create { display: grid; gap: 8px; margin-bottom: 8px; border: 1px solid color-mix(in srgb, var(--focus-ring) 45%, var(--line-subtle)); border-radius: 8px; background: var(--workspace-bg, var(--background)); padding: 9px; }
.repository-branch-create label, .repository-branch-dialog-field { display: grid; gap: 5px; }
.repository-branch-create label > span, .repository-branch-dialog-field > span { color: var(--text-strong); font-size: 10px; font-weight: 700; }
.repository-branch-create input, .repository-branch-dialog-field input, .repository-branch-search input { min-width: 0; border: 1px solid var(--line-subtle); border-radius: 7px; outline: none; background: var(--surface-subtle); color: var(--text); font-size: 11px; }
.repository-branch-create input, .repository-branch-dialog-field input { height: 31px; padding: 0 9px; }
.repository-branch-create input:focus-visible, .repository-branch-dialog-field input:focus-visible, .repository-branch-search:focus-within { border-color: var(--focus-ring); }
.repository-branch-create button { display: flex; min-height: 31px; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--focus-ring); border-radius: 7px; background: color-mix(in srgb, var(--focus-ring) 16%, var(--surface-subtle)); color: var(--text-strong); cursor: pointer; font-size: 10px; font-weight: 700; }
.repository-branch-create button:disabled { cursor: not-allowed; opacity: 0.55; }
.repository-branch-search { gap: 7px; margin-bottom: 7px; border: 1px solid var(--line-subtle); border-radius: 7px; background: var(--surface-subtle); color: var(--text-muted); padding: 0 8px; }
.repository-branch-search input { width: 100%; height: 32px; border: 0; background: transparent; padding: 0; }
.repository-branch-groups {
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  gap: 10px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1px 4px 2px 2px;
  scrollbar-color: color-mix(in srgb, var(--text-muted) 48%, transparent) transparent;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}
.repository-branch-groups::-webkit-scrollbar { width: 7px; }
.repository-branch-groups::-webkit-scrollbar-track { background: transparent; }
.repository-branch-groups::-webkit-scrollbar-thumb { border-radius: 999px; background: color-mix(in srgb, var(--text-muted) 48%, transparent); }
.repository-branch-groups::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--text-muted) 72%, transparent); }
.repository-branch-groups section { display: grid; align-content: start; gap: 1px; }
.repository-branch-groups h3 { display: flex; justify-content: space-between; margin: 0 0 3px; color: var(--text-muted); padding: 3px 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.repository-branch-folder { display: flex; box-sizing: border-box; min-width: 0; min-height: 30px; align-items: center; gap: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 3px 7px; text-align: left; }
.repository-branch-folder:hover, .repository-branch-folder:focus-visible { background: color-mix(in srgb, var(--surface-subtle) 65%, transparent); color: var(--text-strong); }
.repository-branch-folder svg { flex: 0 0 auto; }
.repository-branch-folder svg:first-child { transition: transform 120ms ease; }
.repository-branch-folder svg:first-child.expanded { transform: rotate(90deg); }
.repository-branch-folder strong { overflow: hidden; color: var(--text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.repository-branch-folder-count { flex: 0 0 auto; margin-left: auto; color: var(--text-muted); font-size: 9px; font-weight: 700; }
.repository-branch-row { box-sizing: border-box; min-height: 46px; gap: 4px; border: 0; border-radius: 6px; background: transparent; padding: 2px; transition: background-color 120ms ease, box-shadow 120ms ease; }
.repository-branch-row.remote { min-height: 34px; }
.repository-branch-row:hover { background: color-mix(in srgb, var(--surface-subtle) 58%, transparent); }
.repository-branch-row[data-current="true"] .repository-branch-name { color: var(--brand-accent-muted, var(--brand-accent)); }
.repository-branch-select { display: grid; flex: 1 1 auto; gap: 2px; min-width: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; padding: 5px 6px; text-align: left; }
.repository-branch-row.remote .repository-branch-select { padding-block: 3px; }
.repository-branch-select:focus-visible { outline: 1px solid color-mix(in srgb, var(--focus-ring) 65%, transparent); outline-offset: -1px; }
.repository-branch-select:disabled { cursor: default; }
.repository-branch-name { min-width: 0; gap: 7px; color: var(--text-strong); }
.repository-branch-name > span { overflow: hidden; font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.repository-branch-select small { overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.repository-branch-delete, .repository-branch-track { flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; }
.repository-branch-delete { display: grid; width: 27px; height: 27px; place-items: center; padding: 0; }
.repository-branch-track { padding: 6px 8px; font-size: 10px; font-weight: 700; }
.repository-branch-delete:hover:not(:disabled), .repository-branch-delete:focus-visible { background: var(--surface-subtle); color: var(--status-danger); }
.repository-branch-track:hover:not(:disabled), .repository-branch-track:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-branch-delete:disabled, .repository-branch-track:disabled { cursor: not-allowed; opacity: 0.45; }
.repository-branch-error { align-items: flex-start; gap: 7px; margin-bottom: 7px; color: var(--status-warning); font-size: 10px; line-height: 1.4; }
.repository-branch-state { min-height: 75px; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 11px; }
.repository-branch-state.error { color: var(--status-warning); }
.repository-branch-empty { color: var(--text-muted); padding: 8px; font-size: 10px; }
.repository-branch-delete-summary { gap: 7px; border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--workspace-bg, var(--background)); padding: 10px; }
:global([role="dialog"].repository-branch-dialog) { width: min(460px, calc(100vw - 24px)); border-color: var(--line-subtle); border-radius: 12px; background: var(--surface-raised, var(--background)); color: var(--text); }
.repository-branch-spin { animation: repository-branch-spin 0.9s linear infinite; }
@keyframes repository-branch-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .repository-branch-spin { animation: none; } }
</style>
