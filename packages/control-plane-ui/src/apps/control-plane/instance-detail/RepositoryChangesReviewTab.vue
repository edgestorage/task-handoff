<template>
  <section ref="pageElement" class="repository-review-page">
    <header class="repository-review-head">
      <span class="repository-review-title">
        <GitCompareArrows :size="17" />
        <span><strong>{{ t("repository.review.title") }}</strong><small>{{ repositorySubtitle }}</small></span>
      </span>
      <span class="repository-review-summary">
        <Button variant="ghost" size="icon" :aria-label="t('repository.review.openExplorer')" :title="t('repository.review.explorer')" @click="openFiles"><Files :size="14" /></Button>
        <b>{{ t("repository.reviewExtra.fileCount", { count: logicalFileCount }) }}</b>
        <small>{{ summaryLabel }}</small>
        <Button variant="outline" size="sm" :aria-label="t('repository.common.refresh')" :title="t('repository.common.refresh')" :disabled="loading || mutationPending" @click="refresh"><RefreshCw :class="{ spin: loading }" :size="13" /><span>{{ t("repository.common.refresh") }}</span></Button>
      </span>
    </header>

    <div class="repository-review-toolbar">
      <div class="repository-review-toolbar-left">
        <RepositoryFilePicker v-model:open="filesOpen" v-model:search="filter" :search-label="t('repository.review.filter')" :search-placeholder="t('repository.review.filter')">
          <template #trigger>
            <Button variant="outline" size="sm" class="repository-review-files-trigger"><PanelLeftOpen :size="13" /> {{ t("repository.review.files") }} <b>{{ logicalFileCount }}</b></Button>
          </template>
          <RepositoryFileTree :label="t('repository.review.changedFiles')" :nodes="reviewTreeNodes" @select="selectReviewTreeNode" @toggle="toggleReviewTreeNode">
            <template #trailing="{ node }">
              <b v-if="reviewTreeNode(node.id)?.kind === 'directory'" class="repository-review-tree-count">{{ reviewTreeNode(node.id)?.fileCount }}</b>
              <small v-else class="repository-review-tree-badges"><b v-for="entry in reviewTreeNode(node.id)?.entries || []" :key="changeId(entry)" :data-scope="entry.scope">{{ scopeBadge(entry.scope) }}</b></small>
            </template>
          </RepositoryFileTree>
          <div v-if="!reviewTreeNodes.length" class="repository-review-tree-empty">{{ t("repository.review.noMatch") }}</div>
        </RepositoryFilePicker>
        <div class="repository-review-scopes" role="tablist" :aria-label="t('repository.review.scope')">
          <button v-for="option in scopeOptions" :key="option.value" type="button" role="tab" :aria-selected="scope === option.value" :class="{ active: scope === option.value }" @click="scope = option.value">
            {{ option.label }} <b>{{ option.count }}</b>
          </button>
        </div>
      </div>
      <ToggleGroup :model-value="viewMode" class="repository-review-view-options" type="single" :aria-label="t('repository.review.layout')" @update:model-value="setViewMode">
        <ToggleGroupItem value="unified" :aria-label="t('repository.review.unifiedDiff')"><Rows3 :size="13" /> {{ t("repository.review.unified") }}</ToggleGroupItem>
        <ToggleGroupItem value="split" :aria-label="t('repository.review.splitDiff')" :disabled="!splitAvailable" :title="splitAvailable ? undefined : t('repository.review.splitWide')"><Columns2 :size="13" /> {{ t("repository.review.split") }}</ToggleGroupItem>
      </ToggleGroup>
    </div>

    <div v-if="loading && !changes" class="repository-review-page-state"><LoaderCircle class="spin" :size="20" /> {{ t("repository.review.loading") }}</div>
    <RepositoryErrorNotice v-else-if="pageError && !changes" :error="pageError" :fallback="t('repository.errors.changesLoad')" />
    <div v-else class="repository-review-body">
      <div v-if="mutationMessageKey || pageError" class="repository-review-notices">
        <div v-if="mutationMessageKey" class="repository-review-message success"><CheckCircle2 :size="13" />{{ t(mutationMessageKey) }}</div>
        <RepositoryErrorNotice v-if="pageError" :error="pageError" :fallback="t('repository.errors.operation')" />
      </div>
      <ScrollArea type="auto" :horizontal="false" class="repository-review-content">
        <main ref="scrollContent" class="repository-review-content-viewport">
          <div v-if="!filteredEntries.length" class="repository-review-empty"><CheckCircle2 :size="32" /><strong>{{ t("repository.review.noScope") }}</strong><span>{{ t("repository.review.noScopeHint") }}</span></div>
          <div v-else class="repository-review-virtual-list" :style="{ height: `${virtualTotalSize}px` }">
            <div
              v-for="virtualRow in virtualRows"
              :key="changeId(filteredEntries[virtualRow.index])"
              :ref="measureVirtualRow"
              class="repository-review-virtual-row"
              :data-index="virtualRow.index"
              :style="{ top: `${virtualRow.start}px` }"
            >
              <RepositoryChangeDiffCard
                :id="cardDomId(filteredEntries[virtualRow.index])"
                :collapsed="collapsedChanges.has(changeId(filteredEntries[virtualRow.index]))"
                :entry="filteredEntries[virtualRow.index]"
                :instance-id="instanceId"
                :expanded-gaps="expandedGapsFor(filteredEntries[virtualRow.index])"
                :pending="mutationPending === changeId(filteredEntries[virtualRow.index])"
                :session-id="sessionId"
                :session-kind="sessionKind"
                :snapshot-id="changes?.snapshotId || ''"
                :view-mode="viewMode"
                @collapse-contexts="collapseContexts"
                @discard="confirmDiscard"
                @expand-context="expandContext"
                @open-files="openFiles"
                @stage="stageEntry"
                @toggle-collapsed="toggleCollapsed"
                @unstage="unstageEntry"
                @visible="setActiveChange"
              />
            </div>
          </div>
        </main>
      </ScrollArea>
    </div>

    <Dialog v-model:open="discardOpen">
      <DialogContent class="repository-review-discard-dialog">
        <DialogHeader><DialogTitle>{{ t("repository.review.discardTitle") }}</DialogTitle><DialogDescription>{{ t("repository.review.discardDescription", { path: discardTarget?.path }) }}</DialogDescription></DialogHeader>
        <RepositoryErrorNotice v-if="pageError" :error="pageError" :fallback="t('repository.review.discardError')" />
        <DialogFooter><Button variant="outline" :disabled="Boolean(mutationPending)" @click="discardOpen = false">{{ t("repository.common.cancel") }}</Button><Button variant="destructive" :disabled="Boolean(mutationPending)" @click="discardEntry"><RotateCcw :size="13" /> {{ t("repository.review.discard") }}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import type { RepositoryChangeEntry, RepositoryChanges, RepositoryContext, RepositoryMutationResult, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { CheckCircle2, Columns2, Files, GitCompareArrows, LoaderCircle, PanelLeftOpen, RefreshCw, RotateCcw, Rows3 } from "@lucide/vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { useElementSize, useMediaQuery } from "@vueuse/core";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { ApiError } from "../../../api/client";
import { discardRepositoryWorktree, getRepositoryChanges, getRepositoryContext, stageRepositoryPaths, unstageRepositoryPaths } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import RepositoryChangeDiffCard from "./RepositoryChangeDiffCard.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryFilePicker from "./RepositoryFilePicker.vue";
import RepositoryFileTree, { type RepositoryFileTreeNode } from "./RepositoryFileTree.vue";
import type { ContextDirection, GapExpansion } from "./repositoryDiffPresentation";

type ReviewScope = "all" | "working" | "staged" | "conflict";
type DiffViewMode = "unified" | "split";
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
const { t } = useI18n();
const emit = defineEmits<{ openWorkspace: [target: { cwdFolderId?: string; initialView: "files" | "changes"; page?: "workspace" | "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }] }>();
const queryClient = useQueryClient();
const sessionId = computed(() => typeof props.session.source?.sessionId === "string" ? props.session.source.sessionId : "");
const sessionKind = computed<RepositorySessionKind>(() => props.session.source?.sessionKind === "ai-session" ? "ai-session" : "app-session");
const target = computed(() => ({ instanceId: props.instanceId, sessionId: sessionId.value, sessionKind: sessionKind.value }));
const context = ref<RepositoryContext>();
const changes = ref<RepositoryChanges>();
const loading = ref(false);
const pageError = ref<unknown>();
const mutationPending = ref("");
const mutationMessageKey = ref("");
const scope = ref<ReviewScope>("all");
const filter = ref("");
const filesOpen = ref(false);
const viewMode = ref<DiffViewMode>("unified");
const splitAvailable = useMediaQuery("(min-width: 900px)");
const expandedDirectories = reactive(new Set<string>());
const activeChangeId = ref("");
const discardOpen = ref(false);
const discardTarget = ref<RepositoryChangeEntry>();
const pageElement = ref<HTMLElement>();
const scrollContent = ref<HTMLElement>();
const scrollViewport = ref<HTMLElement>();
const expandedGaps = reactive(new Map<string, GapExpansion>());
const collapsedChanges = reactive(new Set<string>());
const { width: reviewWidth } = useElementSize(pageElement);
const compactLayout = computed(() => reviewWidth.value > 0 && reviewWidth.value <= 720);

const allEntries = computed(() => changes.value?.entries || []);
const filteredEntries = computed(() => allEntries.value
  .filter(matchesScope)
  .filter((entry) => !filter.value.trim() || entry.path.toLowerCase().includes(filter.value.trim().toLowerCase()))
  .sort(compareEntries));
const logicalFileCount = computed(() => new Set(allEntries.value.map((entry) => entry.path)).size);
const repositorySubtitle = computed(() => {
  const branch = context.value?.head?.state === "branch" ? context.value.head.branch : context.value?.head?.state === "detached" ? t("repository.workspace.detached", { commit: context.value.head.oid?.slice(0, 8) }) : t("repository.common.unbornBranch");
  return [context.value?.displayName || t("repository.title"), branch, context.value?.cwdRelativePath ? t("repository.common.cwd", { path: context.value.cwdRelativePath }) : t("repository.common.repositoryRoot")].filter(Boolean).join(" · ");
});
const summaryLabel = computed(() => {
  const summary = changes.value?.summary;
  if (!summary) return t("repository.review.noSnapshot");
  return t("repository.reviewExtra.summary", { conflicts: summary.conflicts, staged: summary.staged, working: summary.unstaged + summary.untracked });
});
const scopeOptions = computed(() => {
  const summary = changes.value?.summary || { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  return [
    { value: "all" as const, label: t("repository.reviewExtra.all"), count: allEntries.value.length },
    { value: "working" as const, label: t("repository.review.working"), count: summary.unstaged + summary.untracked },
    { value: "staged" as const, label: t("repository.review.staged"), count: summary.staged },
    { value: "conflict" as const, label: t("repository.review.conflicts"), count: summary.conflicts },
  ];
});
const flatTree = computed(() => flattenTree(buildTree(filteredEntries.value)));
const reviewTreeNodeMap = computed(() => new Map(flatTree.value.map((node) => [node.key, node])));
const reviewTreeNodes = computed<RepositoryFileTreeNode[]>(() => flatTree.value.map((node) => ({
  id: node.key,
  path: node.path,
  name: node.name,
  kind: node.kind,
  depth: node.depth,
  expandable: node.kind === "directory",
  expanded: node.kind === "directory" && expandedDirectories.has(node.path),
  selectable: node.kind === "file",
  active: node.entries.some((entry) => changeId(entry) === activeChangeId.value),
  icon: node.kind === "file" ? "diff" : undefined,
})));
const rowVirtualizer = useVirtualizer(computed(() => ({
  count: filteredEntries.value.length,
  estimateSize: () => 360,
  getItemKey: (index: number) => changeId(filteredEntries.value[index]),
  getScrollElement: () => scrollViewport.value || null,
  gap: compactLayout.value ? 0 : 13,
  overscan: 3,
  paddingEnd: compactLayout.value ? 0 : 13,
  paddingStart: compactLayout.value ? 0 : 13,
})));
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems());
const virtualTotalSize = computed(() => rowVirtualizer.value.getTotalSize());

onMounted(() => {
  syncScrollViewport();
  void refresh();
});
watch(scrollContent, syncScrollViewport, { flush: "post" });
watch([() => props.instanceId, sessionId, sessionKind], () => {
  void refresh();
});
watch(splitAvailable, (available) => {
  if (!available && viewMode.value === "split") viewMode.value = "unified";
});

async function refresh() {
  if (!props.instanceId || !sessionId.value || loading.value) return;
  loading.value = true;
  pageError.value = undefined;
  mutationMessageKey.value = "";
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

function reviewTreeNode(id: string) {
  return reviewTreeNodeMap.value.get(id);
}

function toggleReviewTreeNode(node: RepositoryFileTreeNode) {
  toggleDirectory(node.path);
}

function selectReviewTreeNode(node: RepositoryFileTreeNode) {
  const entry = reviewTreeNode(node.id)?.entries[0];
  if (entry) focusChange(entry);
}

function changeId(entry: RepositoryChangeEntry) { return `${entry.scope}:${entry.path}`; }
function syncScrollViewport() {
  scrollViewport.value = scrollContent.value?.closest<HTMLElement>("[data-task-handoff-scroll-viewport]") || undefined;
}
function toggleCollapsed(entry: RepositoryChangeEntry) {
  const id = changeId(entry);
  if (collapsedChanges.has(id)) collapsedChanges.delete(id);
  else collapsedChanges.add(id);
}
function cardDomId(entry: RepositoryChangeEntry) { return `repository-review-${encodeURIComponent(changeId(entry))}`; }
function expandedGapKey(entry: RepositoryChangeEntry, gapId: string) { return `${changeId(entry)}\0${entry.version}\0${gapId}`; }
function expandedGapsFor(entry: RepositoryChangeEntry) {
  const prefix = `${changeId(entry)}\0${entry.version}\0`;
  return new Map([...expandedGaps].filter(([key]) => key.startsWith(prefix)).map(([key, expansion]) => [key.slice(prefix.length), expansion]));
}
function setViewMode(value: unknown) {
  if (value === "unified" || value === "split") viewMode.value = value;
}
function expandContext(entry: RepositoryChangeEntry, gapId: string, direction: ContextDirection, lineCount: number) {
  const key = expandedGapKey(entry, gapId);
  const current = expandedGaps.get(key) || { fromStart: 0, fromEnd: 0 };
  expandedGaps.set(key, direction === "up"
    ? { ...current, fromEnd: Math.min(3_000, current.fromEnd + lineCount) }
    : { ...current, fromStart: Math.min(3_000, current.fromStart + lineCount) });
}
function collapseContexts(entry: RepositoryChangeEntry) {
  const prefix = `${changeId(entry)}\0${entry.version}\0`;
  for (const key of expandedGaps.keys()) if (key.startsWith(prefix)) expandedGaps.delete(key);
}
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
  await mutateEntry(entry, () => stageRepositoryPaths(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId() }), entry.scope === "conflict" ? "repository.review.markedResolved" : "repository.review.stagedSuccess");
}

async function unstageEntry(entry: RepositoryChangeEntry) {
  await mutateEntry(entry, () => unstageRepositoryPaths(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId() }), "repository.review.unstagedSuccess");
}

function confirmDiscard(entry: RepositoryChangeEntry) {
  discardTarget.value = entry;
  pageError.value = undefined;
  discardOpen.value = true;
}

async function discardEntry() {
  const entry = discardTarget.value;
  if (!entry) return;
  await mutateEntry(entry, () => discardRepositoryWorktree(target.value, { paths: [{ path: entry.path, expectedVersion: entry.version }], expectedSnapshotId: requireSnapshotId(), confirm: true }), "repository.review.discardedSuccess");
  if (!pageError.value) discardOpen.value = false;
}

async function mutateEntry(entry: RepositoryChangeEntry, operation: () => Promise<RepositoryMutationResult>, successKey: string) {
  if (mutationPending.value) return;
  mutationPending.value = changeId(entry);
  pageError.value = undefined;
  mutationMessageKey.value = "";
  try {
    const result = await operation();
    context.value = result.context;
    if (result.changes) changes.value = result.changes;
    else await refresh();
    queryClient.setQueryData(["repository-context", props.instanceId, sessionKind.value, sessionId.value], result.context);
    mutationMessageKey.value = successKey;
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
  const cwdFolderId = props.session.source?.cwdFolderId;
  emit("openWorkspace", {
    initialView: "files",
    page: "workspace",
    sessionId: sessionId.value,
    sessionKind: sessionKind.value,
    ...(typeof cwdFolderId === "string" && cwdFolderId ? { cwdFolderId } : {}),
  });
}

</script>

<style scoped>
.repository-review-page { container: repository-review / inline-size; display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; background: var(--workspace-bg); color: var(--text); }
.repository-review-head { display: flex; min-height: 52px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-subtle); background: var(--surface); padding: 0 11px 0 15px; }
.repository-review-title, .repository-review-summary { display: flex; min-width: 0; align-items: center; gap: 9px; }
.repository-review-title > svg { flex: 0 0 auto; color: var(--brand-accent); }
.repository-review-title > span { display: grid; min-width: 0; gap: 1px; }
.repository-review-title strong { color: var(--text-strong); font-size: 13px; }
.repository-review-title small, .repository-review-summary small { overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.repository-review-summary { flex: 0 0 auto; }
.repository-review-summary b { color: var(--text); font-size: 12px; }
.repository-review-summary :deep(button) { height: 28px; gap: 5px; font-size: 12px; }
.repository-review-toolbar { display: flex; min-height: 42px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised); padding: 5px 9px; }
.repository-review-toolbar-left { display: flex; min-width: 0; align-items: center; gap: 7px; }
.repository-review-files-trigger { height: 29px; gap: 6px; font-size: 12px; }
.repository-review-files-trigger b { min-width: 17px; border-radius: 999px; background: var(--workspace-bg); padding: 1px 5px; font-size: 10px; }
.repository-review-scopes { display: flex; align-items: center; gap: 4px; }
.repository-review-scopes button { display: flex; height: 29px; align-items: center; gap: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0 9px; font-size: 12px; }
.repository-review-scopes button:hover, .repository-review-scopes button.active { background: var(--surface-active); color: var(--text-strong); }
.repository-review-scopes b { min-width: 17px; border-radius: 999px; background: var(--workspace-bg); padding: 1px 5px; font-size: 10px; }
.repository-review-view-options { gap: 2px; border: 1px solid var(--line-subtle); border-radius: 6px; background: var(--surface-inset); padding: 2px; }
.repository-review-view-options :deep(button) { height: 24px; min-width: 0; gap: 5px; border-radius: 4px; color: var(--text-muted); padding: 0 7px; font-size: 12px; }
.repository-review-view-options :deep(button[data-state="on"]) { background: var(--surface); color: var(--text-strong); box-shadow: var(--shadow-soft); }
.repository-review-body { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
.repository-review-message { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; border-radius: 6px; padding: 7px; font-size: 12px; }
.repository-review-message.success { background: var(--status-success-bg); color: var(--status-success); }
.repository-review-notices { display: grid; gap: 6px; padding: 8px 13px 0; }
.repository-review-tree-count { color: var(--text-subtle); font-size: 12px; font-weight: 400; }
.repository-review-tree-badges { display: flex; align-items: center; gap: 3px; }
.repository-review-tree-badges b { min-width: 16px; border-radius: 4px; padding: 1px 4px; color: var(--text-muted); font-size: 12px; font-weight: 500; text-align: center; }
.repository-review-tree-badges b[data-scope="conflict"] { background: var(--status-danger-bg); color: var(--status-danger); }
.repository-review-tree-badges b[data-scope="staged"] { background: var(--status-success-bg); color: var(--status-success); }
.repository-review-tree-badges b[data-scope="unstaged"], .repository-review-tree-badges b[data-scope="untracked"] { background: var(--status-warning-bg); color: var(--status-warning); }
.repository-review-tree-empty { color: var(--text-muted); padding: 18px 12px; font-size: 12px; text-align: center; }
.repository-review-content { min-width: 0; min-height: 0; grid-row: 2; }
.repository-review-content :deep([data-task-handoff-scroll-viewport]) { scroll-padding-top: 13px; }
.repository-review-content-viewport { width: 100%; min-width: 0; min-height: 100%; }
.repository-review-virtual-list { position: relative; width: calc(100% - 26px); min-width: 0; margin: 0 13px; }
/* Rows are offset with `top`, not `transform`: a transformed row makes Chromium offset descendant sticky headers by the scroll position. */
.repository-review-virtual-row { position: absolute; top: 0; left: 0; width: 100%; }
.repository-review-empty, .repository-review-page-state { display: flex; min-height: 0; flex: 1 1 auto; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--text-muted); font-size: 12px; }
.repository-review-empty strong { color: var(--text-strong); font-size: 13px; }
:global([role="dialog"].repository-review-discard-dialog) { width: min(480px, calc(100vw - 32px)); border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.spin { animation: repository-review-spin 0.9s linear infinite; }
@keyframes repository-review-spin { to { transform: rotate(360deg); } }
@container repository-review (max-width: 720px) {
  .repository-review-head { min-height: 40px; gap: 8px; padding: 5px 8px; }
  .repository-review-title { flex: 1 1 auto; gap: 6px; }
  .repository-review-title > span { display: flex; align-items: baseline; gap: 6px; }
  .repository-review-title strong { flex: 0 0 auto; }
  .repository-review-summary { flex: 0 0 auto; gap: 6px; }
  .repository-review-summary small, .repository-review-summary button span { display: none; }
  .repository-review-summary :deep(button) { width: 28px; padding: 0; }
  .repository-review-toolbar { display: grid; min-height: 38px; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; padding: 4px 8px; }
  .repository-review-toolbar-left { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px; }
  .repository-review-scopes { display: grid; min-width: 0; grid-auto-flow: column; grid-auto-columns: minmax(max-content, 1fr); gap: 2px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
  .repository-review-scopes::-webkit-scrollbar { display: none; }
  .repository-review-scopes button { justify-content: center; padding: 0 6px; white-space: nowrap; }
  .repository-review-virtual-list { width: 100%; margin: 0; }
}
@container repository-review (max-width: 560px) {
  .repository-review-scopes button b { display: none; }
  .repository-review-view-options :deep(button) { width: 28px; justify-content: center; gap: 0; padding: 0; font-size: 0; }
}
</style>
