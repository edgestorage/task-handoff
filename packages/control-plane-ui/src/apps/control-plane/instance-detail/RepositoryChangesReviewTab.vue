<template>
  <section class="repository-review-page">
    <header class="repository-review-head">
      <span class="repository-review-title">
        <GitCompareArrows :size="17" />
        <span><strong>Changes</strong><small>{{ repositorySubtitle }}</small></span>
      </span>
      <span class="repository-review-summary">
        <b>{{ logicalFileCount }} file{{ logicalFileCount === 1 ? "" : "s" }}</b>
        <small>{{ summaryLabel }}</small>
        <Button variant="outline" size="sm" :disabled="loading || mutationPending" @click="refresh"><RefreshCw :class="{ spin: loading }" :size="13" /> Refresh</Button>
      </span>
    </header>

    <div class="repository-review-toolbar">
      <div class="repository-review-toolbar-left">
        <Popover v-model:open="filesOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="repository-review-files-trigger"><PanelLeftOpen :size="13" /> Files <b>{{ logicalFileCount }}</b></Button>
          </PopoverTrigger>
          <PopoverContent class="repository-review-files-popover" align="start" :side-offset="6">
            <aside class="repository-review-tree-panel">
              <label class="repository-review-filter"><Search :size="13" /><input v-model="filter" type="search" placeholder="Filter changed files…" aria-label="Filter changed files" /></label>
              <div class="repository-review-tree" role="tree" aria-label="Changed files">
                <template v-for="node in flatTree" :key="node.key">
                  <button v-if="node.kind === 'directory'" type="button" class="repository-review-tree-directory" role="treeitem" :aria-expanded="expandedDirectories.has(node.path)" :style="treeIndent(node.depth)" @click="toggleDirectory(node.path)">
                    <ChevronRight :class="{ expanded: expandedDirectories.has(node.path) }" :size="13" />
                    <Folder :size="13" />
                    <span>{{ node.name }}</span><b>{{ node.fileCount }}</b>
                  </button>
                  <button v-else type="button" class="repository-review-tree-file" role="treeitem" :data-active="node.entries.some((entry) => changeId(entry) === activeChangeId) ? 'true' : undefined" :style="treeIndent(node.depth)" :title="node.path" @click="focusChange(node.entries[0])">
                    <FileDiff :size="13" />
                    <span>{{ node.name }}</span>
                    <small><b v-for="entry in node.entries" :key="changeId(entry)" :data-scope="entry.scope">{{ scopeBadge(entry.scope) }}</b></small>
                  </button>
                </template>
                <div v-if="!flatTree.length" class="repository-review-tree-empty">No changed files match this view.</div>
              </div>
            </aside>
          </PopoverContent>
        </Popover>
        <div class="repository-review-scopes" role="tablist" aria-label="Change scope">
          <button v-for="option in scopeOptions" :key="option.value" type="button" role="tab" :aria-selected="scope === option.value" :class="{ active: scope === option.value }" @click="scope = option.value">
            {{ option.label }} <b>{{ option.count }}</b>
          </button>
        </div>
      </div>
      <span class="repository-review-view-options"><Button variant="ghost" size="sm" disabled><Rows3 :size="13" /> Unified</Button></span>
    </div>

    <div v-if="loading && !changes" class="repository-review-page-state"><LoaderCircle class="spin" :size="20" /> Loading repository changes…</div>
    <RepositoryErrorNotice v-else-if="pageError && !changes" :error="pageError" fallback="Repository changes could not be loaded." />
    <div v-else class="repository-review-body">
      <div v-if="mutationMessage || pageError" class="repository-review-notices">
        <div v-if="mutationMessage" class="repository-review-message success"><CheckCircle2 :size="13" />{{ mutationMessage }}</div>
        <RepositoryErrorNotice v-if="pageError" :error="pageError" fallback="Repository operation failed." />
      </div>
      <main ref="scrollElement" class="repository-review-content">
        <div v-if="!filteredEntries.length" class="repository-review-empty"><CheckCircle2 :size="32" /><strong>No changes in this scope</strong><span>Choose another scope or refresh the repository snapshot.</span></div>
        <div v-else class="repository-review-virtual-list" :style="{ height: `${virtualTotalSize}px` }">
          <div
            v-for="virtualRow in virtualRows"
            :key="changeId(filteredEntries[virtualRow.index])"
            :ref="measureVirtualRow"
            class="repository-review-virtual-row"
            :data-index="virtualRow.index"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <RepositoryChangeDiffCard
              :id="cardDomId(filteredEntries[virtualRow.index])"
              :entry="filteredEntries[virtualRow.index]"
              :instance-id="instanceId"
              :pending="mutationPending === changeId(filteredEntries[virtualRow.index])"
              :session-id="sessionId"
              :session-kind="sessionKind"
              :snapshot-id="changes?.snapshotId || ''"
              @discard="confirmDiscard"
              @open-files="openFiles"
              @stage="stageEntry"
              @unstage="unstageEntry"
              @visible="setActiveChange"
            />
          </div>
        </div>
      </main>
    </div>

    <Dialog v-model:open="discardOpen">
      <DialogContent class="repository-review-discard-dialog">
        <DialogHeader><DialogTitle>Discard working tree change?</DialogTitle><DialogDescription>This restores <strong>{{ discardTarget?.path }}</strong> from the index. Existing staged content is retained.</DialogDescription></DialogHeader>
        <RepositoryErrorNotice v-if="pageError" :error="pageError" fallback="The working tree change could not be discarded." />
        <DialogFooter><Button variant="outline" :disabled="Boolean(mutationPending)" @click="discardOpen = false">Cancel</Button><Button variant="destructive" :disabled="Boolean(mutationPending)" @click="discardEntry"><RotateCcw :size="13" /> Discard change</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import type { RepositoryChangeEntry, RepositoryChanges, RepositoryContext, RepositoryMutationResult, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { CheckCircle2, ChevronRight, FileDiff, Folder, GitCompareArrows, LoaderCircle, PanelLeftOpen, RefreshCw, RotateCcw, Rows3, Search } from "@lucide/vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { ApiError } from "../../../api/client";
import { discardRepositoryWorktree, getRepositoryChanges, getRepositoryContext, stageRepositoryPaths, unstageRepositoryPaths } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import RepositoryChangeDiffCard from "./RepositoryChangeDiffCard.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import { repositoryWorkspaceChannelName } from "./repositoryWorkspaceWindow";

type ReviewScope = "all" | "working" | "staged" | "conflict";
type ReviewTreeNode = {
  key: string;
  kind: "directory" | "file";
  name: string;
  path: string;
  children: ReviewTreeNode[];
  entries: RepositoryChangeEntry[];
  depth: number;
  fileCount: number;
};

const props = defineProps<{ instanceId: string; session: { source?: Record<string, unknown> } }>();
const emit = defineEmits<{ openWorkspace: [target: { initialView: "files" | "changes"; page?: "workspace" | "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }] }>();
const queryClient = useQueryClient();
const sessionId = computed(() => typeof props.session.source?.sessionId === "string" ? props.session.source.sessionId : "");
const sessionKind = computed<RepositorySessionKind>(() => props.session.source?.sessionKind === "ai-session" ? "ai-session" : "app-session");
const target = computed(() => ({ instanceId: props.instanceId, sessionId: sessionId.value, sessionKind: sessionKind.value }));
const context = ref<RepositoryContext>();
const changes = ref<RepositoryChanges>();
const loading = ref(false);
const pageError = ref<unknown>();
const mutationPending = ref("");
const mutationMessage = ref("");
const scope = ref<ReviewScope>("all");
const filter = ref("");
const filesOpen = ref(false);
const expandedDirectories = reactive(new Set<string>());
const activeChangeId = ref("");
const discardOpen = ref(false);
const discardTarget = ref<RepositoryChangeEntry>();
const scrollElement = ref<HTMLElement>();
let repositoryChannel: BroadcastChannel | undefined;

const allEntries = computed(() => changes.value?.entries || []);
const filteredEntries = computed(() => allEntries.value
  .filter(matchesScope)
  .filter((entry) => !filter.value.trim() || entry.path.toLowerCase().includes(filter.value.trim().toLowerCase()))
  .sort(compareEntries));
const logicalFileCount = computed(() => new Set(allEntries.value.map((entry) => entry.path)).size);
const repositorySubtitle = computed(() => {
  const branch = context.value?.head?.state === "branch" ? context.value.head.branch : context.value?.head?.state === "detached" ? `detached ${context.value.head.oid?.slice(0, 8)}` : "unborn branch";
  return [context.value?.displayName || "Repository", branch, context.value?.cwdRelativePath ? `cwd: ${context.value.cwdRelativePath}` : "repository root"].filter(Boolean).join(" · ");
});
const summaryLabel = computed(() => {
  const summary = changes.value?.summary;
  if (!summary) return "No snapshot";
  return [`${summary.conflicts} conflicts`, `${summary.staged} staged`, `${summary.unstaged + summary.untracked} working`].join(" · ");
});
const scopeOptions = computed(() => {
  const summary = changes.value?.summary || { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  return [
    { value: "all" as const, label: "All", count: allEntries.value.length },
    { value: "working" as const, label: "Working", count: summary.unstaged + summary.untracked },
    { value: "staged" as const, label: "Staged", count: summary.staged },
    { value: "conflict" as const, label: "Conflicts", count: summary.conflicts },
  ];
});
const flatTree = computed(() => flattenTree(buildTree(filteredEntries.value)));
const rowVirtualizer = useVirtualizer(computed(() => ({
  count: filteredEntries.value.length,
  estimateSize: () => 360,
  getItemKey: (index: number) => changeId(filteredEntries.value[index]),
  getScrollElement: () => scrollElement.value || null,
  gap: 13,
  overscan: 3,
  paddingEnd: 13,
  paddingStart: 13,
})));
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems());
const virtualTotalSize = computed(() => rowVirtualizer.value.getTotalSize());

onMounted(() => {
  connectRepositoryChannel();
  void refresh();
});
onBeforeUnmount(() => repositoryChannel?.close());
watch([() => props.instanceId, sessionId, sessionKind], () => {
  connectRepositoryChannel();
  void refresh();
});

async function refresh() {
  if (!props.instanceId || !sessionId.value || loading.value) return;
  loading.value = true;
  pageError.value = undefined;
  mutationMessage.value = "";
  try {
    const [nextContext, nextChanges] = await Promise.all([getRepositoryContext(target.value), getRepositoryChanges(target.value)]);
    context.value = nextContext;
    changes.value = nextChanges;
    initializeExpandedDirectories(nextChanges.entries);
    queryClient.setQueryData(["repository-context", props.instanceId, sessionKind.value, sessionId.value], nextContext);
  } catch (cause) {
    pageError.value = cause;
  } finally {
    loading.value = false;
  }
}

function matchesScope(entry: RepositoryChangeEntry) {
  if (scope.value === "all") return true;
  if (scope.value === "working") return entry.scope === "unstaged" || entry.scope === "untracked";
  if (scope.value === "staged") return entry.scope === "staged";
  return entry.scope === "conflict";
}

function compareEntries(left: RepositoryChangeEntry, right: RepositoryChangeEntry) {
  const pathDelta = left.path.localeCompare(right.path);
  if (pathDelta) return pathDelta;
  const order = { conflict: 0, staged: 1, unstaged: 2, untracked: 3 };
  return order[left.scope] - order[right.scope];
}

function buildTree(entries: RepositoryChangeEntry[]) {
  const root: ReviewTreeNode = { key: "root", kind: "directory", name: "", path: "", children: [], entries: [], depth: -1, fileCount: 0 };
  const files = new Map<string, RepositoryChangeEntry[]>();
  for (const entry of entries) files.set(entry.path, [...(files.get(entry.path) || []), entry]);
  for (const [filePath, fileEntries] of files) {
    const segments = filePath.split("/");
    let parent = root;
    segments.forEach((segment, index) => {
      const nodePath = segments.slice(0, index + 1).join("/");
      const isFile = index === segments.length - 1;
      let node = parent.children.find((candidate) => candidate.name === segment && candidate.kind === (isFile ? "file" : "directory"));
      if (!node) {
        node = { key: `${isFile ? "file" : "directory"}:${nodePath}`, kind: isFile ? "file" : "directory", name: segment, path: nodePath, children: [], entries: isFile ? fileEntries : [], depth: index, fileCount: isFile ? 1 : 0 };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  countFiles(root);
  sortTree(root);
  return root.children;
}

function countFiles(node: ReviewTreeNode): number {
  if (node.kind === "file") return 1;
  node.fileCount = node.children.reduce((total, child) => total + countFiles(child), 0);
  return node.fileCount;
}

function sortTree(node: ReviewTreeNode) {
  node.children.sort((left, right) => Number(left.kind === "file") - Number(right.kind === "file") || left.name.localeCompare(right.name));
  node.children.forEach(sortTree);
}

function flattenTree(nodes: ReviewTreeNode[], result: ReviewTreeNode[] = []) {
  for (const node of nodes) {
    result.push(node);
    if (node.kind === "directory" && expandedDirectories.has(node.path)) flattenTree(node.children, result);
  }
  return result;
}

function initializeExpandedDirectories(entries: RepositoryChangeEntry[]) {
  if (expandedDirectories.size) return;
  for (const entry of entries) {
    const segments = entry.path.split("/").slice(0, -1);
    segments.forEach((_, index) => expandedDirectories.add(segments.slice(0, index + 1).join("/")));
  }
}

function toggleDirectory(path: string) {
  if (expandedDirectories.has(path)) expandedDirectories.delete(path);
  else expandedDirectories.add(path);
}

function treeIndent(depth: number) {
  return { paddingLeft: `${8 + depth * 14}px` };
}

function changeId(entry: RepositoryChangeEntry) { return `${entry.scope}:${entry.path}`; }
function cardDomId(entry: RepositoryChangeEntry) { return `repository-review-${encodeURIComponent(changeId(entry))}`; }
function measureVirtualRow(element: unknown) {
  if (element instanceof HTMLElement) rowVirtualizer.value.measureElement(element);
}
function focusChange(entry: RepositoryChangeEntry) {
  activeChangeId.value = changeId(entry);
  filesOpen.value = false;
  const index = filteredEntries.value.findIndex((candidate) => changeId(candidate) === changeId(entry));
  if (index >= 0) rowVirtualizer.value.scrollToIndex(index, { align: "start" });
}
function setActiveChange(entry: RepositoryChangeEntry) { activeChangeId.value = changeId(entry); }
function scopeBadge(value: RepositoryChangeEntry["scope"]) { return ({ conflict: "C", staged: "S", unstaged: "W", untracked: "U" }[value]); }

async function stageEntry(entry: RepositoryChangeEntry) {
  await mutateEntry(entry, () => stageRepositoryPaths(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId() }), entry.scope === "conflict" ? "Marked conflict as resolved and staged it." : "Staged change.");
}

async function unstageEntry(entry: RepositoryChangeEntry) {
  await mutateEntry(entry, () => unstageRepositoryPaths(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId() }), "Unstaged change.");
}

function confirmDiscard(entry: RepositoryChangeEntry) {
  discardTarget.value = entry;
  pageError.value = undefined;
  discardOpen.value = true;
}

async function discardEntry() {
  const entry = discardTarget.value;
  if (!entry) return;
  await mutateEntry(entry, () => discardRepositoryWorktree(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId(), confirm: true }), "Discarded working tree change.");
  if (!pageError.value) discardOpen.value = false;
}

async function mutateEntry(entry: RepositoryChangeEntry, operation: () => Promise<RepositoryMutationResult>, success: string) {
  if (mutationPending.value) return;
  mutationPending.value = changeId(entry);
  pageError.value = undefined;
  mutationMessage.value = "";
  try {
    const result = await operation();
    context.value = result.context;
    if (result.changes) changes.value = result.changes;
    else await refresh();
    queryClient.setQueryData(["repository-context", props.instanceId, sessionKind.value, sessionId.value], result.context);
    mutationMessage.value = success;
    repositoryChannel?.postMessage({ type: "repository-invalidated" });
  } catch (cause) {
    pageError.value = cause;
    if (cause instanceof ApiError && cause.code === "REPOSITORY_STATE_STALE") {
      await recoverAuthority();
      pageError.value = cause;
    }
  } finally {
    mutationPending.value = "";
  }
}

async function recoverAuthority() {
  try {
    const [nextContext, nextChanges] = await Promise.all([getRepositoryContext(target.value), getRepositoryChanges(target.value)]);
    context.value = nextContext;
    changes.value = nextChanges;
    queryClient.setQueryData(["repository-context", props.instanceId, sessionKind.value, sessionId.value], nextContext);
  } catch {
    // Keep the original mutation error visible; an explicit Refresh remains available.
  }
}

function requireSnapshotId() {
  if (!changes.value?.snapshotId) throw new Error("Repository snapshot is unavailable.");
  return changes.value.snapshotId;
}

function openFiles() {
  emit("openWorkspace", { initialView: "files", page: "workspace", sessionId: sessionId.value, sessionKind: sessionKind.value });
}

function connectRepositoryChannel() {
  repositoryChannel?.close();
  repositoryChannel = undefined;
  if (typeof BroadcastChannel === "undefined") return;
  repositoryChannel = new BroadcastChannel(repositoryWorkspaceChannelName(target.value));
  repositoryChannel.addEventListener("message", () => {
    if (!loading.value && !mutationPending.value) void refresh();
  });
}
</script>

<style scoped>
.repository-review-page { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; background: var(--workspace-bg); color: var(--text); }
.repository-review-head { display: flex; min-height: 52px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-subtle); background: var(--surface); padding: 0 11px 0 15px; }
.repository-review-title, .repository-review-summary { display: flex; min-width: 0; align-items: center; gap: 9px; }
.repository-review-title > svg { flex: 0 0 auto; color: var(--brand-accent); }
.repository-review-title > span { display: grid; min-width: 0; gap: 1px; }
.repository-review-title strong { color: var(--text-strong); font-size: 13px; }
.repository-review-title small, .repository-review-summary small { overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.repository-review-summary { flex: 0 0 auto; }
.repository-review-summary b { color: var(--text); font-size: 10px; }
.repository-review-summary :deep(button) { height: 28px; gap: 5px; font-size: 9px; }
.repository-review-toolbar { display: flex; min-height: 42px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised); padding: 5px 9px; }
.repository-review-toolbar-left { display: flex; min-width: 0; align-items: center; gap: 7px; }
.repository-review-files-trigger { height: 29px; gap: 6px; font-size: 10px; }
.repository-review-files-trigger b { min-width: 17px; border-radius: 999px; background: var(--workspace-bg); padding: 1px 5px; font-size: 8px; }
.repository-review-scopes { display: flex; align-items: center; gap: 4px; }
.repository-review-scopes button { display: flex; height: 29px; align-items: center; gap: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0 9px; font-size: 10px; }
.repository-review-scopes button:hover, .repository-review-scopes button.active { background: var(--surface-active); color: var(--text-strong); }
.repository-review-scopes b { min-width: 17px; border-radius: 999px; background: var(--workspace-bg); padding: 1px 5px; font-size: 8px; }
.repository-review-view-options :deep(button) { height: 28px; gap: 5px; font-size: 9px; }
.repository-review-body { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
:global(.repository-review-files-popover) { display: grid; width: min(360px, calc(100vw - 24px)); height: min(680px, calc(100vh - 150px)); overflow: hidden; border-color: var(--line-subtle); background: var(--surface-raised); padding: 0; color: var(--text); }
.repository-review-tree-panel { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--surface-raised); padding-top: 7px; }
.repository-review-filter { display: flex; height: 30px; align-items: center; gap: 6px; margin: 0 7px 7px; border: 1px solid var(--line-subtle); border-radius: 6px; background: var(--surface-inset); color: var(--text-muted); padding: 0 8px; }
.repository-review-filter input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 10px; }
.repository-review-filter input::placeholder { color: var(--text-subtle); }
.repository-review-message { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; border-radius: 6px; padding: 7px; font-size: 9px; }
.repository-review-message.success { background: var(--status-success-bg); color: var(--status-success); }
.repository-review-notices { display: grid; gap: 6px; padding: 8px 13px 0; }
.repository-review-tree { min-height: 0; overflow: auto; padding: 1px 5px 10px; }
.repository-review-tree button { display: flex; width: 100%; min-width: 0; height: 28px; align-items: center; gap: 5px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; padding-right: 6px; text-align: left; }
.repository-review-tree button:hover, .repository-review-tree-file[data-active="true"] { background: var(--surface-active); color: var(--text-strong); }
.repository-review-tree button > svg { flex: 0 0 auto; }
.repository-review-tree button > span { min-width: 0; flex: 1 1 auto; overflow: hidden; font: 10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.repository-review-tree-directory > svg:first-child { transition: transform 120ms ease; }
.repository-review-tree-directory > svg:first-child.expanded { transform: rotate(90deg); }
.repository-review-tree-directory > b { color: var(--text-subtle); font-size: 8px; }
.repository-review-tree-file > small { display: flex; flex: 0 0 auto; align-items: center; gap: 3px; }
.repository-review-tree-file > small b { min-width: 16px; border-radius: 4px; padding: 1px 4px; color: var(--text-muted); font-size: 8px; text-align: center; }
.repository-review-tree-file > small b[data-scope="conflict"] { background: var(--status-danger-bg); color: var(--status-danger); }
.repository-review-tree-file > small b[data-scope="staged"] { background: var(--status-success-bg); color: var(--status-success); }
.repository-review-tree-file > small b[data-scope="unstaged"], .repository-review-tree-file > small b[data-scope="untracked"] { background: var(--status-warning-bg); color: var(--status-warning); }
.repository-review-tree-file > small > svg { color: var(--status-success); }
.repository-review-tree-empty { color: var(--text-muted); padding: 18px 12px; font-size: 10px; text-align: center; }
.repository-review-content { min-width: 0; min-height: 0; overflow: auto; scroll-padding-top: 13px; }
.repository-review-virtual-list { position: relative; width: calc(100% - 26px); min-width: 0; margin: 0 13px; }
.repository-review-virtual-row { position: absolute; top: 0; left: 0; width: 100%; }
.repository-review-empty, .repository-review-page-state { display: flex; min-height: 0; flex: 1 1 auto; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--text-muted); font-size: 10px; }
.repository-review-empty strong { color: var(--text-strong); font-size: 13px; }
:global([role="dialog"].repository-review-discard-dialog) { width: min(480px, calc(100vw - 32px)); border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.spin { animation: repository-review-spin 0.9s linear infinite; }
@keyframes repository-review-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .repository-review-summary small, .repository-review-scopes button b { display: none; } .repository-review-scopes button { padding: 0 6px; } }
</style>
