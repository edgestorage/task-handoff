<template>
  <section class="repository-workspace">
    <div class="repository-workspace-content">
      <header class="repository-workspace-head">
        <span class="repository-workspace-title">
          <FolderGit2 :size="17" />
          <span><strong>{{ t("repository.workspace.explorer") }}</strong><small>{{ workspaceSubtitle }}</small></span>
        </span>
        <span class="repository-workspace-head-actions">
          <Button
            variant="ghost"
            size="icon"
            class="repository-workspace-view-switch"
            :aria-label="t('repository.workspace.openChanges')"
            :title="changeCount ? t('repository.workspace.changesCount', { count: changeCount }) : t('repository.changes')"
            @click="openChangesReview"
          >
            <GitCompareArrows :size="14" />
            <span v-if="changeCount" class="repository-workspace-view-count">{{ changeCount }}</span>
          </Button>
        </span>
      </header>

      <div ref="workspaceBody" class="repository-workspace-body" :style="{ '--repository-sidebar-width': `${sidebarWidth}px` }" tabindex="-1">
        <aside class="repository-workspace-sidebar">
          <div class="repository-workspace-sidebar-actions">
            <Button variant="ghost" size="sm" @click="openNewFileDialog"><FilePlus2 :size="13" /> {{ t("repository.workspace.newFile") }}</Button>
          </div>
          <ScrollArea type="always" class="repository-workspace-sidebar-content">
            <div class="repository-workspace-sidebar-content-inner">
            <div v-if="loadingWorkspace" class="repository-workspace-sidebar-state"><LoaderCircle class="repository-workspace-spin" :size="16" /> {{ t("repository.workspace.loading") }}</div>
            <RepositoryErrorNotice v-else-if="workspaceLoadError" :error="workspaceLoadError" :fallback="t('repository.errors.workspaceLoad')" />
            <template v-else>
              <div v-if="directoryLoadError" class="repository-workspace-directory-error">
                <small>{{ directoryLoadError.path }}</small>
                <RepositoryErrorNotice :error="directoryLoadError.error" :fallback="t('repository.errors.directoryLoad')" />
              </div>
              <RepositoryFileTree
                :directories="directories"
                :expanded-paths="expandedPaths"
                path=""
                @open-file="openFile"
                @toggle-directory="toggleDirectory"
              />
            </template>
            </div>
          </ScrollArea>
        </aside>

        <div class="repository-workspace-resize-handle" role="separator" :aria-label="t('repository.workspace.resizeSidebar')" aria-orientation="vertical" :aria-valuenow="Math.round(sidebarWidth)" tabindex="0" @pointerdown="startSidebarResize" @dblclick="sidebarWidth = 320" @keydown.left.prevent="setSidebarWidth(sidebarWidth - 16)" @keydown.right.prevent="setSidebarWidth(sidebarWidth + 16)" />

        <main class="repository-workspace-main">
          <div v-if="tabs.length" ref="workspaceOpenTabs" class="repository-workspace-tabs" role="tablist" :aria-label="t('repository.workspace.openFiles')" @keydown="navigateOpenTabs" @wheel="scrollOpenTabs">
            <div v-for="tab in tabs" :key="tab.id" class="repository-workspace-tab" :class="{ active: activeTabId === tab.id }">
              <button type="button" role="tab" :data-repository-tab="tab.id" :tabindex="activeTabId === tab.id ? 0 : -1" :aria-selected="activeTabId === tab.id" @click="selectTab(tab.id)">
                <FileCode2 :size="13" />
                <span>{{ tab.path }}</span>
              </button>
              <button type="button" class="repository-workspace-tab-close" :aria-label="t('repository.workspace.closeFile', { path: tab.path })" @click="closeTab(tab.id)"><X :size="12" /></button>
            </div>
          </div>
          <section v-if="fileOpenError" class="repository-workspace-editor repository-workspace-file-error">
            <header><span><strong>{{ fileOpenError.path }}</strong></span></header>
            <div class="repository-workspace-editor-body repository-workspace-file-error-body">
              <RepositoryErrorNotice :error="fileOpenError.error" :fallback="t('repository.errors.fileLoad')" />
            </div>
          </section>
          <section v-else-if="activeTab" class="repository-workspace-editor">
            <header>
              <span><strong>{{ activeTab.path }}</strong><small>{{ formatBytes(activeTab.byteLength, locale as SupportedLocale) }} · {{ t(activeTab.mode.executable ? "repository.workspace.executable" : "repository.workspace.text") }}</small></span>
              <span class="repository-workspace-editor-actions">
                <Button variant="ghost" size="sm" :disabled="fileActionPending" @click="openRenameDialog(activeTab)"><PencilLine :size="13" /> {{ t("repository.workspace.rename") }}</Button>
                <Button variant="ghost" size="sm" :disabled="fileActionPending" @click="openDeleteDialog(activeTab)"><Trash2 :size="13" /> {{ t("repository.workspace.delete") }}</Button>
              </span>
            </header>
            <div class="repository-workspace-editor-body">
              <RepositoryFilePreview :content="activeTab.content" :line="activeTab.line" :path="activeTab.path" />
            </div>
          </section>
          <section v-else class="repository-workspace-empty">
            <FolderOpen :size="38" />
            <strong>{{ t("repository.workspace.openFile") }}</strong>
            <span>{{ t("repository.workspace.browseHint") }}</span>
          </section>
        </main>
      </div>

      <Dialog v-model:open="newFileDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>{{ t("repository.workspace.newFileTitle") }}</DialogTitle><DialogDescription>{{ t("repository.workspace.newFileDescription") }}</DialogDescription></DialogHeader>
          <form class="repository-file-action-form" @submit.prevent="createFile">
            <label for="repository-new-file-path">{{ t("repository.workspace.filePath") }}</label>
            <!-- i18n-audit-allow-next-line code-token: example repository-relative path -->
            <Input id="repository-new-file-path" v-model="newFilePath" autocomplete="off" placeholder="src/new-file.ts" />
            <RepositoryErrorNotice v-if="newFileError" :error="newFileError" :fallback="t('repository.workspace.createError')" />
            <DialogFooter><Button type="button" variant="outline" :disabled="fileActionPending" @click="newFileDialogOpen = false">{{ t("repository.common.cancel") }}</Button><Button type="submit" :disabled="fileActionPending || !newFilePath.trim()"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><FilePlus2 v-else :size="13" />{{ t(fileActionPending ? "repository.workspace.creating" : "repository.workspace.create") }}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="renameDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>{{ t("repository.workspace.renameTitle") }}</DialogTitle><DialogDescription>{{ t("repository.workspace.renameDescription") }}</DialogDescription></DialogHeader>
          <form class="repository-file-action-form" @submit.prevent="renameFile">
            <label for="repository-rename-file-path">{{ t("repository.workspace.newPath") }}</label>
            <Input id="repository-rename-file-path" v-model="renameDestination" autocomplete="off" />
            <RepositoryErrorNotice v-if="renameError" :error="renameError" :fallback="t('repository.workspace.renameError')" />
            <DialogFooter><Button type="button" variant="outline" :disabled="fileActionPending" @click="renameDialogOpen = false">{{ t("repository.common.cancel") }}</Button><Button type="submit" :disabled="fileActionPending || !renameDestination.trim()"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><PencilLine v-else :size="13" />{{ t(fileActionPending ? "repository.workspace.renaming" : "repository.workspace.renameFile") }}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="deleteDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>{{ t("repository.workspace.deleteTitle") }}</DialogTitle><DialogDescription>{{ t("repository.workspace.deleteDescription", { path: deleteTarget?.path }) }}</DialogDescription></DialogHeader>
          <RepositoryErrorNotice v-if="deleteError" :error="deleteError" :fallback="t('repository.workspace.deleteError')" />
          <DialogFooter><Button variant="outline" :disabled="fileActionPending" @click="deleteDialogOpen = false">{{ t("repository.common.cancel") }}</Button><Button variant="destructive" :disabled="fileActionPending" @click="deleteFile"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><Trash2 v-else :size="13" />{{ t(fileActionPending ? "repository.workspace.deleting" : "repository.workspace.deleteFile") }}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  </section>
</template>

<script setup lang="ts">
import type {
  RepositoryContext,
  RepositoryDirectoryEntry,
  RepositoryDirectoryListing,
  RepositoryFileContent,
  RepositoryFileMutationResult,
  RepositorySessionKind,
} from "@task-handoff/protocol/repository";
import { FileCode2, FilePlus2, FolderGit2, FolderOpen, GitCompareArrows, LoaderCircle, PencilLine, Trash2, X } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "../../../api/client";
import { createRepositoryFile, deleteRepositoryFile, getRepositoryChanges, getRepositoryContext, getRepositoryDirectory, getRepositoryFile, renameRepositoryFile } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { SupportedLocale } from "../../../i18n/locale";
import { formatBytes } from "../../../i18n/presentation";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryFilePreview from "./RepositoryFilePreview.vue";
import RepositoryFileTree from "./RepositoryFileTree.vue";
import { repositoryFileLocation } from "./repositoryFilePath";

type FileTab = RepositoryFileContent & {
  id: string;
  kind: "file";
  line?: number;
};

type ScopedRepositoryError = {
  path: string;
  error: unknown;
};

const props = defineProps<{
  context: RepositoryContext;
  instanceId: string;
  initialFilePath?: string;
  initialFileRequestId?: number;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>();
const { locale, t } = useI18n();

const emit = defineEmits<{
  openChanges: [target: { initialView: "changes"; page: "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }];
}>();

function openChangesReview() {
  emit("openChanges", { initialView: "changes", page: "changes-review", sessionId: props.sessionId, sessionKind: props.sessionKind });
}

const queryClient = useQueryClient();
const target = computed(() => ({ instanceId: props.instanceId, sessionKind: props.sessionKind, sessionId: props.sessionId }));
const directories = ref<Map<string, RepositoryDirectoryListing>>(new Map());
const expandedPaths = ref<Set<string>>(new Set());
const changes = ref<Awaited<ReturnType<typeof getRepositoryChanges>>>();
const tabs = ref<FileTab[]>([]);
const activeTabId = ref("");
const workspaceOpenTabs = ref<HTMLElement>();
const workspaceBody = ref<HTMLElement>();
const sidebarWidth = ref(320);
const loadingWorkspace = ref(false);
const workspaceLoadError = ref<unknown>();
const directoryLoadError = ref<ScopedRepositoryError>();
const fileOpenError = ref<ScopedRepositoryError>();
const loadRevision = ref(0);
let fileOpenRevision = 0;
const newFileDialogOpen = ref(false);
const newFilePath = ref("");
const newFileError = ref<unknown>();
const renameDialogOpen = ref(false);
const renameTarget = ref<FileTab>();
const renameDestination = ref("");
const renameError = ref<unknown>();
const deleteDialogOpen = ref(false);
const deleteTarget = ref<FileTab>();
const deleteError = ref<unknown>();
const fileActionPending = ref(false);
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value));
const changeCount = computed(() => changes.value?.entries.length || 0);
const workspaceSubtitle = computed(() => {
  const branch = props.context.head?.state === "branch" ? props.context.head.branch : props.context.head?.state === "detached"
    ? t("repository.workspace.detached", { commit: props.context.head.oid?.slice(0, 8) || "" })
    : t("repository.workspace.unborn");
  return [branch, props.context.cwdRelativePath ? t("repository.common.cwd", { path: props.context.cwdRelativePath }) : t("repository.common.repositoryRoot")].filter(Boolean).join(" · ");
});
let stopSidebarResize: (() => void) | undefined;

onBeforeUnmount(() => {
  stopSidebarResize?.();
});

function setSidebarWidth(width: number) {
  const maxWidth = Math.max(280, (workspaceBody.value?.clientWidth || 960) * 0.62);
  sidebarWidth.value = Math.min(maxWidth, Math.max(220, width));
}

function startSidebarResize(event: PointerEvent) {
  if (event.button !== 0 || !workspaceBody.value) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;
  document.body.classList.add("repository-sidebar-resizing");
  const move = (moveEvent: PointerEvent) => setSidebarWidth(startWidth + moveEvent.clientX - startX);
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.classList.remove("repository-sidebar-resizing");
    stopSidebarResize = undefined;
  };
  stopSidebarResize?.();
  stopSidebarResize = stop;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

function navigateOpenTabs(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !tabs.value.length) return;
  event.preventDefault();
  const currentIndex = Math.max(0, tabs.value.findIndex((tab) => tab.id === activeTabId.value));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.value.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.value.length) % tabs.value.length;
  activeTabId.value = tabs.value[nextIndex]!.id;
  void nextTick(() => workspaceOpenTabs.value?.querySelector<HTMLButtonElement>(`[data-repository-tab="${CSS.escape(activeTabId.value)}"]`)?.focus());
}

function scrollOpenTabs(event: WheelEvent) {
  const tabList = workspaceOpenTabs.value;
  if (!tabList || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || tabList.scrollWidth <= tabList.clientWidth) return;
  const nextScrollLeft = Math.max(0, Math.min(tabList.scrollWidth - tabList.clientWidth, tabList.scrollLeft + event.deltaY));
  if (nextScrollLeft === tabList.scrollLeft) return;
  event.preventDefault();
  tabList.scrollLeft = nextScrollLeft;
}

watch(() => `${props.instanceId}:${props.sessionKind}:${props.sessionId}`, () => {
  void loadWorkspace();
}, { immediate: true });

async function loadWorkspace() {
  const revision = ++loadRevision.value;
  loadingWorkspace.value = true;
  workspaceLoadError.value = undefined;
  directoryLoadError.value = undefined;
  fileOpenError.value = undefined;
  fileOpenRevision += 1;
  try {
    const [root, nextChanges] = await Promise.all([
      getRepositoryDirectory(target.value, ""),
      getRepositoryChanges(target.value),
    ]);
    if (revision !== loadRevision.value) return;
    directories.value = new Map([["", root]]);
    expandedPaths.value = new Set();
    changes.value = nextChanges;
  } catch (error) {
    if (revision === loadRevision.value) workspaceLoadError.value = error;
  } finally {
    if (revision === loadRevision.value) loadingWorkspace.value = false;
  }
}

async function toggleDirectory(entry: RepositoryDirectoryEntry) {
  directoryLoadError.value = undefined;
  const next = new Set(expandedPaths.value);
  if (next.has(entry.path)) {
    next.delete(entry.path);
    expandedPaths.value = next;
    return;
  }
  if (!directories.value.has(entry.path)) {
    try {
      const listing = await getRepositoryDirectory(target.value, entry.path);
      directories.value = new Map(directories.value).set(entry.path, listing);
    } catch (error) {
      directoryLoadError.value = { path: entry.path, error };
      return;
    }
  }
  next.add(entry.path);
  expandedPaths.value = next;
}

async function openFile(entry: RepositoryDirectoryEntry | { path: string; line?: number }) {
  const revision = ++fileOpenRevision;
  const id = `file:${entry.path}`;
  const line = "line" in entry ? entry.line : undefined;
  fileOpenError.value = undefined;
  const existing = tabs.value.find((tab) => tab.id === id);
  if (existing) {
    existing.line = line;
    selectTab(id, revision);
    return;
  }
  try {
    const file = await getRepositoryFile(target.value, entry.path);
    if (revision !== fileOpenRevision) return;
    tabs.value.push({ ...file, id, kind: "file", line });
    activeTabId.value = id;
  } catch (error) {
    if (revision !== fileOpenRevision) return;
    activeTabId.value = "";
    fileOpenError.value = { path: entry.path, error };
  }
}

function selectTab(id: string, revision = ++fileOpenRevision) {
  if (revision !== fileOpenRevision) return;
  fileOpenError.value = undefined;
  activeTabId.value = id;
}

watch(
  [() => props.initialFileRequestId, () => props.initialFilePath, () => props.context.repositoryRoot, () => props.context.cwdRelativePath],
  ([, href]) => {
    if (!href) return;
    const location = repositoryFileLocation(href, props.context);
    if (location) void openFile(location);
  },
  { immediate: true },
);

function openNewFileDialog() {
  newFilePath.value = "";
  newFileError.value = undefined;
  newFileDialogOpen.value = true;
}

async function createFile() {
  const path = newFilePath.value.trim();
  if (!path || fileActionPending.value) return;
  fileActionPending.value = true;
  newFileError.value = undefined;
  try {
    const result = await createRepositoryFile(target.value, {
      path,
      content: "",
      expectedAbsent: true,
      expectedSnapshotId: requireSnapshotId(),
    });
    const file = requireMutationFile(result);
    await applyFileMutation(result);
    const id = `file:${file.path}`;
    tabs.value.push({ ...file, id, kind: "file" });
    selectTab(id);
    newFileDialogOpen.value = false;
  } catch (error) {
    newFileError.value = error;
    if (isStale(error)) await refreshRepositoryState();
  } finally {
    fileActionPending.value = false;
  }
}

function openRenameDialog(tab: FileTab) {
  renameTarget.value = tab;
  renameDestination.value = tab.path;
  renameError.value = undefined;
  renameDialogOpen.value = true;
}

async function renameFile() {
  const tab = renameTarget.value;
  const destination = renameDestination.value.trim();
  if (!tab || !destination || destination === tab.path || fileActionPending.value) return;
  fileActionPending.value = true;
  renameError.value = undefined;
  const oldId = tab.id;
  try {
    const result = await renameRepositoryFile(target.value, {
      path: tab.path,
      destination,
      expectedVersion: tab.version,
      expectedDestinationAbsent: true,
      expectedSnapshotId: requireSnapshotId(),
    });
    const file = requireMutationFile(result);
    await applyFileMutation(result);
    Object.assign(tab, file, { id: `file:${file.path}`, kind: "file" });
    if (activeTabId.value === oldId) activeTabId.value = tab.id;
    renameDialogOpen.value = false;
  } catch (error) {
    renameError.value = error;
    if (isStale(error)) {
      await Promise.all([refreshRepositoryState(), refreshOpenFile(tab)]);
    }
  } finally {
    fileActionPending.value = false;
  }
}

function openDeleteDialog(tab: FileTab) {
  deleteTarget.value = tab;
  deleteError.value = undefined;
  deleteDialogOpen.value = true;
}

async function deleteFile() {
  const tab = deleteTarget.value;
  if (!tab || fileActionPending.value) return;
  fileActionPending.value = true;
  deleteError.value = undefined;
  try {
    const result = await deleteRepositoryFile(target.value, {
      path: tab.path,
      expectedVersion: tab.version,
      expectedSnapshotId: requireSnapshotId(),
      confirm: true,
    });
    await applyFileMutation(result);
    closeTab(tab.id);
    deleteDialogOpen.value = false;
  } catch (error) {
    deleteError.value = error;
    if (isStale(error)) {
      await Promise.all([refreshRepositoryState(), refreshOpenFile(tab)]);
    }
  } finally {
    fileActionPending.value = false;
  }
}

async function refreshOpenFile(tab: FileTab) {
  try {
    Object.assign(tab, await getRepositoryFile(target.value, tab.path));
  } catch {}
}

async function refreshOpenFiles() {
  await Promise.all(tabs.value.map(refreshOpenFile));
}

async function refreshRepositoryState() {
  try {
    const [nextContext, nextChanges] = await Promise.all([
      getRepositoryContext(target.value),
      getRepositoryChanges(target.value),
    ]);
    changes.value = nextChanges;
    queryClient.setQueryData(repositoryContextQueryKey(), nextContext);
  } catch {
    // The mutation error remains the authoritative user-facing result.
  }
}

async function applyFileMutation(result: RepositoryFileMutationResult) {
  changes.value = result.changes;
  queryClient.setQueryData(repositoryContextQueryKey(), result.context);
  await refreshLoadedDirectories();
}

async function refreshLoadedDirectories() {
  const paths = [...directories.value.keys()];
  const refreshed = await Promise.allSettled(paths.map(async (path) => [path, await getRepositoryDirectory(target.value, path)] as const));
  const next = new Map(directories.value);
  for (const item of refreshed) if (item.status === "fulfilled") next.set(item.value[0], item.value[1]);
  directories.value = next;
}

function repositoryContextQueryKey() {
  return ["repository-context", props.instanceId, props.sessionKind, props.sessionId];
}

function requireSnapshotId() {
  const snapshotId = changes.value?.snapshotId || props.context.snapshotId;
  if (!snapshotId) throw new Error("Repository snapshot is unavailable. Refresh the workspace and try again.");
  return snapshotId;
}

function requireMutationFile(result: RepositoryFileMutationResult) {
  if (!result.file) throw new Error("The server did not return the updated file.");
  return result.file;
}

function isStale(error: unknown) {
  return error instanceof ApiError && (error.code === "REPOSITORY_FILE_STALE" || error.code === "REPOSITORY_STATE_STALE");
}

function closeTab(id: string) {
  const index = tabs.value.findIndex((tab) => tab.id === id);
  tabs.value = tabs.value.filter((tab) => tab.id !== id);
  if (activeTabId.value === id) activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || "";
}

</script>

<style scoped>
.repository-workspace { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.repository-workspace-content { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--workspace-bg, var(--background)); color: var(--text); }
.repository-workspace-head { display: flex; min-height: 52px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); padding: 0 10px 0 15px; }
.repository-workspace-title, .repository-workspace-title > span { display: flex; align-items: center; }
.repository-workspace-title { gap: 9px; }
.repository-workspace-title > span { align-items: flex-start; flex-direction: column; gap: 2px; }
.repository-workspace-title strong { color: var(--text-strong); font-size: 13px; }
.repository-workspace-title small { color: var(--text-muted); font-size: 12px; }
.repository-workspace-head-actions { display: flex; min-width: 0; align-items: center; gap: 2px; }
.repository-workspace-head-actions > button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
.repository-workspace-head-actions > button:hover, .repository-workspace-head-actions > button:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-head-actions :deep(.repository-workspace-view-switch) { display: inline-flex; width: auto; min-width: 30px; height: 30px; align-items: center; justify-content: center; gap: 5px; padding: 0 7px; white-space: nowrap; }
.repository-workspace-view-count { display: inline-flex; min-width: 19px; height: 18px; align-items: center; justify-content: center; border: 1px solid var(--line-subtle); border-radius: 999px; background: var(--surface-subtle); color: var(--text); font-size: 11px; font-weight: 600; line-height: 1; padding: 0 5px; }
.repository-workspace-body { display: grid; min-height: 0; grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); overflow: hidden; }
.repository-workspace-sidebar { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); background: var(--surface-raised, var(--background)); }
.repository-workspace-resize-handle { position: relative; z-index: 2; cursor: col-resize; background: transparent; touch-action: none; }
.repository-workspace-resize-handle::after { position: absolute; top: 0; bottom: 0; left: 2.5px; width: 2px; background: var(--line-subtle); content: ""; }
.repository-workspace-resize-handle:hover::after, :global(body.repository-sidebar-resizing) .repository-workspace-resize-handle::after { background: var(--focus-ring); }
:global(body.repository-sidebar-resizing) { cursor: col-resize; user-select: none; }
.repository-workspace-sidebar-actions { display: flex; min-height: 38px; align-items: center; justify-content: flex-end; border-bottom: 1px solid var(--line-subtle); padding: 4px 7px; }
.repository-workspace-sidebar-actions :deep(button) { gap: 5px; height: 30px; padding: 0 8px; font-size: 12px; }
.repository-workspace-sidebar-content { min-width: 0; min-height: 0; }
.repository-workspace-sidebar-content-inner { min-width: 0; padding: 7px; }
.repository-workspace-directory-error { display: grid; gap: 5px; margin-bottom: 7px; }
.repository-workspace-directory-error > small { overflow: hidden; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-sidebar-content :deep([data-task-handoff-scroll-viewport] > div) { width: 100%; min-width: 0 !important; }
.repository-workspace-sidebar-content :deep([data-orientation="horizontal"]) { display: none; }
.repository-workspace-sidebar-state { display: flex; min-height: 100px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.repository-workspace-sidebar-state.error { color: var(--status-warning); }
.repository-workspace-main { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-tabs { display: flex; min-height: 38px; overflow-x: auto; overflow-y: hidden; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised, var(--background)); padding: 4px 5px 0; scrollbar-width: none; }
.repository-workspace-tabs::-webkit-scrollbar { display: none; }
.repository-workspace-tab { display: flex; min-width: 130px; max-width: 260px; align-items: stretch; border-bottom: 2px solid transparent; color: var(--text-muted); }
.repository-workspace-tab.active { border-bottom-color: var(--focus-ring); color: var(--text-strong); }
.repository-workspace-tab > [role="tab"] { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 6px; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px 0 9px; }
.repository-workspace-tab > [role="tab"] > span { flex: 1 1 auto; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-tab small { color: var(--text-muted); }
.repository-workspace-tab-close { display: grid; width: 26px; flex: 0 0 26px; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.repository-workspace-tab-close:hover, .repository-workspace-tab-close:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-editor { display: grid; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-editor > header { display: flex; min-height: 48px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); padding: 0 13px; }
.repository-workspace-editor > header > span:first-child { display: grid; gap: 2px; }
.repository-workspace-editor header strong { font-size: 13px; }
.repository-workspace-editor header small { color: var(--text-muted); font-size: 12px; }
.repository-workspace-editor-actions { display: flex; align-items: center; gap: 6px; }
.repository-workspace-editor-actions :deep(button) { gap: 5px; height: 30px; padding: 0 9px; font-size: 12px; }
.repository-workspace-editor-body { display: flex; min-height: 0; overflow: hidden; flex-direction: column; background: var(--workspace-bg); }
.repository-workspace-file-error { grid-row: 2; }
.repository-workspace-file-error-body { align-items: center; justify-content: center; padding: 24px; }
.repository-workspace-file-error-body :deep(.repository-error-notice) { width: min(680px, 100%); }
.repository-workspace-empty { display: flex; min-height: 0; grid-row: 2; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); }
.repository-workspace-empty strong { color: var(--text-strong); font-size: 13px; }
.repository-workspace-empty span { font-size: 12px; }
.repository-workspace-spin { animation: repository-workspace-spin 0.9s linear infinite; }
:global([role="dialog"].repository-file-action-dialog) { width: min(480px, calc(100vw - 32px)); gap: 14px; border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.repository-file-action-form { display: grid; gap: 9px; }
.repository-file-action-form > label { color: var(--text-muted); font-size: 12px; font-weight: 700; }
.repository-file-action-form > p, .repository-file-action-error { margin: 0; color: var(--status-danger); font-size: 12px; }
.repository-file-action-form :deep(input) { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.repository-file-action-form :deep(button), :global([role="dialog"].repository-file-action-dialog button) { gap: 6px; }
@keyframes repository-workspace-spin { to { transform: rotate(360deg); } }
@media (max-width: 800px) { .repository-workspace-body { grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .repository-workspace-spin { animation: none; } }
</style>
