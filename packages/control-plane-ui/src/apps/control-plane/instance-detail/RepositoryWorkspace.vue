<template>
  <component :is="embedded ? 'section' : Dialog" :open="embedded || open" :class="{ 'repository-workspace-embedded': embedded }" @update:open="$emit('update:open', $event)">
    <component :is="embedded ? 'div' : DialogContent" :class="['repository-workspace-dialog', { 'repository-workspace-window': standalone, 'repository-workspace-embedded-content': embedded }]" @open-auto-focus="focusWorkspace">
      <DialogTitle v-if="!embedded" class="sr-only">File Explorer</DialogTitle>
      <DialogDescription v-if="!embedded" class="sr-only">Browse and edit repository files.</DialogDescription>
      <header class="repository-workspace-head">
        <span class="repository-workspace-title">
          <FolderGit2 :size="17" />
          <span><strong>File Explorer</strong><small>{{ workspaceSubtitle }}</small></span>
        </span>
        <span class="repository-workspace-head-actions">
          <Button
            v-if="!standalone"
            variant="ghost"
            size="icon"
            class="repository-workspace-view-switch"
            :aria-label="changeCount ? `Open Changes (${changeCount})` : 'Open Changes'"
            :title="changeCount ? `Changes · ${changeCount}` : 'Changes'"
            @click="openChangesReview"
          >
            <GitCompareArrows :size="14" />
            <span v-if="changeCount" class="repository-workspace-view-count">{{ changeCount }}</span>
          </Button>
          <small v-if="popoutMessage" class="repository-workspace-popout-message" role="status">{{ popoutMessage }}</small>
          <button v-if="embedded" type="button" aria-label="Open repository workspace as dialog" title="Open as dialog" @click="emit('openDialog')"><Maximize2 :size="16" /></button>
          <button v-else-if="!standalone" type="button" aria-label="Return repository workspace to tab" title="Return to tab" @click="emit('openTab')"><PanelTop :size="16" /></button>
          <button v-if="!standalone" type="button" aria-label="Open repository workspace in new window" title="Open in new window" @click="openInNewWindow"><ExternalLink :size="16" /></button>
          <button v-if="!embedded" type="button" aria-label="Close repository workspace" title="Close" @click="emit('update:open', false)"><X :size="16" /></button>
        </span>
      </header>

      <div ref="workspaceBody" class="repository-workspace-body" :style="{ '--repository-sidebar-width': `${sidebarWidth}px` }" tabindex="-1">
        <aside class="repository-workspace-sidebar">
          <div class="repository-workspace-sidebar-actions">
            <Button variant="ghost" size="sm" @click="openNewFileDialog"><FilePlus2 :size="13" /> New file</Button>
          </div>
          <ScrollArea type="always" class="repository-workspace-sidebar-content">
            <div class="repository-workspace-sidebar-content-inner">
            <div v-if="loadingWorkspace" class="repository-workspace-sidebar-state"><LoaderCircle class="repository-workspace-spin" :size="16" /> Loading repository…</div>
            <RepositoryErrorNotice v-else-if="workspaceError" :error="workspaceError" fallback="Failed to load repository workspace." />
            <RepositoryFileTree
              v-else
              :directories="directories"
              :expanded-paths="expandedPaths"
              path=""
              @open-file="openFile"
              @toggle-directory="toggleDirectory"
            />
            </div>
          </ScrollArea>
        </aside>

        <div class="repository-workspace-resize-handle" role="separator" aria-label="Resize repository sidebar" aria-orientation="vertical" :aria-valuenow="Math.round(sidebarWidth)" tabindex="0" @pointerdown="startSidebarResize" @dblclick="sidebarWidth = 320" @keydown.left.prevent="setSidebarWidth(sidebarWidth - 16)" @keydown.right.prevent="setSidebarWidth(sidebarWidth + 16)" />

        <main class="repository-workspace-main">
          <div v-if="tabs.length" ref="workspaceOpenTabs" class="repository-workspace-tabs" role="tablist" aria-label="Open repository files" @keydown="navigateOpenTabs" @wheel="scrollOpenTabs">
            <div v-for="tab in tabs" :key="tab.id" class="repository-workspace-tab" :class="{ active: activeTabId === tab.id }">
              <button type="button" role="tab" :data-repository-tab="tab.id" :tabindex="activeTabId === tab.id ? 0 : -1" :aria-selected="activeTabId === tab.id" @click="activeTabId = tab.id">
                <FileCode2 :size="13" />
                <span>{{ tab.path }}<small v-if="tab.draft !== tab.content" class="repository-workspace-dirty"> · unsaved</small></span>
              </button>
              <button type="button" class="repository-workspace-tab-close" :aria-label="`Close ${tab.path}`" @click="closeTab(tab.id)"><X :size="12" /></button>
            </div>
          </div>
          <section v-if="activeTab" class="repository-workspace-editor">
            <header>
              <span><strong>{{ activeTab.path }}</strong><small>{{ activeTab.byteLength }} bytes · {{ activeTab.mode.executable ? "executable" : "text" }}</small></span>
              <span class="repository-workspace-editor-actions">
                <Button variant="ghost" size="sm" :disabled="activeTab.saving" @click="openRenameDialog(activeTab)"><PencilLine :size="13" /> Rename</Button>
                <Button variant="ghost" size="sm" :disabled="activeTab.saving" @click="openDeleteDialog(activeTab)"><Trash2 :size="13" /> Delete</Button>
                <Button size="sm" :disabled="activeTab.saving || activeTab.draft === activeTab.content || Boolean(activeTab.staleServer)" @click="saveFile(activeTab)">
                  <LoaderCircle v-if="activeTab.saving" class="repository-workspace-spin" :size="13" /><Save v-else :size="13" />
                  {{ activeTab.saving ? "Saving…" : "Save" }}
                </Button>
              </span>
            </header>
            <div class="repository-workspace-editor-body">
              <div v-if="activeTab.error" class="repository-workspace-editor-error" role="alert"><CircleAlert :size="15" /><span>{{ activeTab.error }}</span></div>
              <div v-if="activeTab.staleServer" class="repository-workspace-stale" role="alert">
                <div><CircleAlert :size="16" /><span><strong>Server version changed</strong><small>Your draft is preserved. Compare both versions before retrying.</small></span></div>
                <div class="repository-workspace-stale-actions">
                  <Button variant="outline" size="sm" @click="activeTab.staleCompared = !activeTab.staleCompared"><Columns2 :size="13" />{{ activeTab.staleCompared ? "Hide comparison" : "Compare versions" }}</Button>
                  <Button variant="outline" size="sm" @click="acceptServerVersion(activeTab)">Use server version</Button>
                  <Button size="sm" :disabled="!activeTab.staleCompared || activeTab.saving" @click="retryStaleSave(activeTab)"><RefreshCw :size="13" /> Retry save</Button>
                </div>
              </div>
              <div v-if="activeTab.staleServer && activeTab.staleCompared" class="repository-workspace-compare" aria-label="Draft and server version comparison">
                <section><strong>Your draft</strong><pre>{{ activeTab.draft }}</pre></section>
                <section><strong>Server version · {{ activeTab.staleServer.version.slice(0, 10) }}</strong><pre>{{ activeTab.staleServer.content }}</pre></section>
              </div>
              <textarea v-else v-model="activeTab.draft" :aria-label="`Edit ${activeTab.path}`" spellcheck="false" />
            </div>
          </section>
          <section v-else class="repository-workspace-empty">
            <FolderOpen :size="38" />
            <strong>Open a file</strong>
            <span>Browse repository-relative files from the explorer.</span>
          </section>
        </main>
      </div>

      <Dialog v-model:open="newFileDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>New repository file</DialogTitle><DialogDescription>Create an empty UTF-8 text file using a repository-relative path.</DialogDescription></DialogHeader>
          <form class="repository-file-action-form" @submit.prevent="createFile">
            <label for="repository-new-file-path">File path</label>
            <Input id="repository-new-file-path" v-model="newFilePath" autocomplete="off" placeholder="src/new-file.ts" />
            <RepositoryErrorNotice v-if="newFileError" :error="newFileError" fallback="File could not be created." />
            <DialogFooter><Button type="button" variant="outline" :disabled="fileActionPending" @click="newFileDialogOpen = false">Cancel</Button><Button type="submit" :disabled="fileActionPending || !newFilePath.trim()"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><FilePlus2 v-else :size="13" />{{ fileActionPending ? "Creating…" : "Create file" }}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="renameDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>Rename repository file</DialogTitle><DialogDescription>The destination must not already exist. Any unsaved draft remains open after the rename.</DialogDescription></DialogHeader>
          <form class="repository-file-action-form" @submit.prevent="renameFile">
            <label for="repository-rename-file-path">New path</label>
            <Input id="repository-rename-file-path" v-model="renameDestination" autocomplete="off" />
            <RepositoryErrorNotice v-if="renameError" :error="renameError" fallback="File could not be renamed." />
            <DialogFooter><Button type="button" variant="outline" :disabled="fileActionPending" @click="renameDialogOpen = false">Cancel</Button><Button type="submit" :disabled="fileActionPending || !renameDestination.trim()"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><PencilLine v-else :size="13" />{{ fileActionPending ? "Renaming…" : "Rename file" }}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="deleteDialogOpen">
        <DialogContent class="repository-file-action-dialog">
          <DialogHeader><DialogTitle>Delete repository file?</DialogTitle><DialogDescription>This permanently removes <strong>{{ deleteTarget?.path }}</strong>. Any unsaved draft for this file will be lost.</DialogDescription></DialogHeader>
          <RepositoryErrorNotice v-if="deleteError" :error="deleteError" fallback="File could not be deleted." />
          <DialogFooter><Button variant="outline" :disabled="fileActionPending" @click="deleteDialogOpen = false">Cancel</Button><Button variant="destructive" :disabled="fileActionPending" @click="deleteFile"><LoaderCircle v-if="fileActionPending" class="repository-workspace-spin" :size="13" /><Trash2 v-else :size="13" />{{ fileActionPending ? "Deleting…" : "Delete file" }}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

    </component>
  </component>
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
import { CircleAlert, Columns2, ExternalLink, FileCode2, FilePlus2, FolderGit2, FolderOpen, GitCompareArrows, LoaderCircle, Maximize2, PanelTop, PencilLine, RefreshCw, Save, Trash2, X } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError } from "../../../api/client";
import { createRepositoryFile, deleteRepositoryFile, getRepositoryChanges, getRepositoryContext, getRepositoryDirectory, getRepositoryFile, renameRepositoryFile, writeRepositoryFile } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryFileTree from "./RepositoryFileTree.vue";
import { openRepositoryWorkspaceWindow, repositoryWorkspaceChannelName } from "./repositoryWorkspaceWindow";

type FileTab = RepositoryFileContent & {
  id: string;
  kind: "file";
  draft: string;
  error?: string;
  saving?: boolean;
  staleCompared?: boolean;
  staleServer?: RepositoryFileContent;
};

const props = defineProps<{
  context: RepositoryContext;
  embedded?: boolean;
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  standalone?: boolean;
}>();

const emit = defineEmits<{
  openChanges: [target: { initialView: "changes"; page: "changes-review"; sessionId: string; sessionKind: RepositorySessionKind }];
  openDialog: [];
  openTab: [];
  "update:open": [open: boolean];
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
const workspaceError = ref<unknown>();
const loadRevision = ref(0);
const popoutMessage = ref("");
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
const hasUnsavedDrafts = computed(() => tabs.value.some((tab) => tab.kind === "file" && tab.draft !== tab.content));
const workspaceSubtitle = computed(() => {
  const branch = props.context.head?.state === "branch" ? props.context.head.branch : props.context.head?.state === "detached" ? `detached ${props.context.head.oid?.slice(0, 8) || ""}` : "unborn";
  return [branch, props.context.cwdRelativePath ? `cwd: ${props.context.cwdRelativePath}` : "repository root"].filter(Boolean).join(" · ");
});
let repositoryChannel: BroadcastChannel | undefined;
let stopSidebarResize: (() => void) | undefined;

onMounted(() => {
  connectRepositoryChannel();
  window.addEventListener("focus", refreshFromExternalChange);
});

onBeforeUnmount(() => {
  window.removeEventListener("focus", refreshFromExternalChange);
  repositoryChannel?.close();
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

function connectRepositoryChannel() {
  repositoryChannel?.close();
  repositoryChannel = undefined;
  if (typeof BroadcastChannel === "undefined") return;
  repositoryChannel = new BroadcastChannel(repositoryWorkspaceChannelName(target.value));
  repositoryChannel.addEventListener("message", refreshFromExternalChange);
}

async function openInNewWindow() {
  popoutMessage.value = "";
  try {
    const opened = await openRepositoryWorkspaceWindow({ ...target.value, view: "files" });
    if (!opened) {
      popoutMessage.value = "New window was blocked.";
      return;
    }
    if (hasUnsavedDrafts.value) {
      popoutMessage.value = "Unsaved drafts remain in this window.";
      return;
    }
    emit("update:open", false);
  } catch (error) {
    popoutMessage.value = error instanceof Error ? error.message : "New window could not be opened.";
  }
}

function notifyRepositoryChanged() {
  repositoryChannel?.postMessage({ type: "repository-invalidated" });
}

function refreshFromExternalChange() {
  if (!props.open || loadingWorkspace.value) return;
  void Promise.all([refreshRepositoryState(), refreshLoadedDirectories()]);
}

function focusWorkspace(event: Event) {
  event.preventDefault();
  void nextTick(() => workspaceBody.value?.focus());
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

watch(() => props.open, (open) => {
  if (!open) return;
  void loadWorkspace();
}, { immediate: true });

watch(() => `${props.instanceId}:${props.sessionKind}:${props.sessionId}`, () => {
  connectRepositoryChannel();
  if (props.open) void loadWorkspace();
});

async function loadWorkspace() {
  const revision = ++loadRevision.value;
  loadingWorkspace.value = true;
  workspaceError.value = undefined;
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
    if (revision === loadRevision.value) workspaceError.value = error;
  } finally {
    if (revision === loadRevision.value) loadingWorkspace.value = false;
  }
}

async function toggleDirectory(entry: RepositoryDirectoryEntry) {
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
      workspaceError.value = error;
      return;
    }
  }
  next.add(entry.path);
  expandedPaths.value = next;
}

async function openFile(entry: RepositoryDirectoryEntry | { path: string }) {
  const id = `file:${entry.path}`;
  const existing = tabs.value.find((tab) => tab.id === id);
  if (existing) { activeTabId.value = id; return; }
  try {
    const file = await getRepositoryFile(target.value, entry.path);
    tabs.value.push({ ...file, id, kind: "file", draft: file.content, error: "", saving: false, staleCompared: false });
    activeTabId.value = id;
  } catch (error) {
    workspaceError.value = error;
  }
}

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
    tabs.value.push({ ...file, id, kind: "file", draft: file.content, error: "", saving: false, staleCompared: false });
    activeTabId.value = id;
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
  const draft = tab.draft;
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
    Object.assign(tab, file, { id: `file:${file.path}`, kind: "file", draft, error: "", staleServer: undefined, staleCompared: false });
    if (activeTabId.value === oldId) activeTabId.value = tab.id;
    renameDialogOpen.value = false;
  } catch (error) {
    renameError.value = error;
    if (isStale(error)) {
      await loadServerVersion(tab);
      renameDialogOpen.value = false;
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
      await loadServerVersion(tab);
      deleteDialogOpen.value = false;
    }
  } finally {
    fileActionPending.value = false;
  }
}

async function saveFile(tab: FileTab, expectedVersion = tab.version) {
  if (tab.saving || tab.draft === tab.content) return;
  tab.saving = true;
  tab.error = "";
  try {
    const result = await writeRepositoryFile(target.value, {
      path: tab.path,
      content: tab.draft,
      expectedVersion,
      expectedSnapshotId: requireSnapshotId(),
    });
    const file = requireMutationFile(result);
    await applyFileMutation(result);
    Object.assign(tab, file, { draft: file.content, error: "", staleServer: undefined, staleCompared: false });
  } catch (error) {
    if (isStale(error)) await loadServerVersion(tab);
    else tab.error = mutationMessage(error, "File could not be saved.");
  } finally {
    tab.saving = false;
  }
}

async function retryStaleSave(tab: FileTab) {
  if (!tab.staleServer || !tab.staleCompared) return;
  await saveFile(tab, tab.staleServer.version);
}

function acceptServerVersion(tab: FileTab) {
  if (!tab.staleServer) return;
  const server = tab.staleServer;
  Object.assign(tab, server, { draft: server.content, error: "", staleServer: undefined, staleCompared: false });
}

async function loadServerVersion(tab: FileTab) {
  const draft = tab.draft;
  try {
    const [server] = await Promise.all([getRepositoryFile(target.value, tab.path), refreshRepositoryState()]);
    tab.draft = draft;
    tab.staleServer = server;
    tab.staleCompared = false;
    tab.error = "";
  } catch (error) {
    tab.draft = draft;
    tab.error = `Your draft is preserved. ${mutationMessage(error, "The server version could not be loaded.")}`;
  }
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
  notifyRepositoryChanged();
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

function mutationMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function closeTab(id: string) {
  const index = tabs.value.findIndex((tab) => tab.id === id);
  tabs.value = tabs.value.filter((tab) => tab.id !== id);
  if (activeTabId.value === id) activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || "";
}

</script>

<style scoped>
:global([role="dialog"].repository-workspace-dialog) { display: grid; top: calc(50% + 24px); width: min(1500px, calc(100vw - 32px)); max-width: none; height: min(920px, calc(100vh - 80px)); grid-template-rows: auto minmax(0, 1fr); gap: 0; overflow: hidden; border-color: var(--line-subtle); border-radius: 13px; background: var(--workspace-bg, var(--background)); padding: 0; color: var(--text); }
:global([role="dialog"].repository-workspace-dialog.repository-workspace-window) { top: 50%; width: 100vw; height: 100vh; border: 0; border-radius: 0; box-shadow: none; }
.repository-workspace-embedded { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.repository-workspace-embedded-content { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--workspace-bg, var(--background)); color: var(--text); }
.repository-workspace-head { display: flex; min-height: 52px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); padding: 0 10px 0 15px; }
.repository-workspace-title, .repository-workspace-title > span { display: flex; align-items: center; }
.repository-workspace-title { gap: 9px; }
.repository-workspace-title > span { align-items: flex-start; flex-direction: column; gap: 2px; }
.repository-workspace-title strong { color: var(--text-strong); font-size: 13px; }
.repository-workspace-title small { color: var(--text-muted); font-size: 10px; }
.repository-workspace-head-actions { display: flex; min-width: 0; align-items: center; gap: 2px; }
.repository-workspace-head-actions > button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
.repository-workspace-head-actions > button:hover, .repository-workspace-head-actions > button:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-head-actions :deep(.repository-workspace-view-switch) { display: inline-flex; width: auto; min-width: 30px; height: 30px; align-items: center; justify-content: center; gap: 5px; padding: 0 7px; white-space: nowrap; }
.repository-workspace-view-count { display: inline-flex; min-width: 17px; height: 16px; align-items: center; justify-content: center; border: 1px solid var(--line-subtle); border-radius: 999px; background: var(--surface-subtle); color: var(--text); font-size: 9px; font-weight: 600; line-height: 1; padding: 0 4px; }
.repository-workspace-popout-message { max-width: 300px; overflow: hidden; margin-right: 6px; color: var(--status-warning); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-body { display: grid; min-height: 0; grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); overflow: hidden; }
.repository-workspace-sidebar { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); background: var(--surface-raised, var(--background)); }
.repository-workspace-resize-handle { position: relative; z-index: 2; cursor: col-resize; background: transparent; touch-action: none; }
.repository-workspace-resize-handle::after { position: absolute; top: 0; bottom: 0; left: 2.5px; width: 2px; background: var(--line-subtle); content: ""; }
.repository-workspace-resize-handle:hover::after, :global(body.repository-sidebar-resizing) .repository-workspace-resize-handle::after { background: var(--focus-ring); }
:global(body.repository-sidebar-resizing) { cursor: col-resize; user-select: none; }
.repository-workspace-sidebar-actions { display: flex; min-height: 38px; align-items: center; justify-content: flex-end; border-bottom: 1px solid var(--line-subtle); padding: 4px 7px; }
.repository-workspace-sidebar-actions :deep(button) { gap: 5px; height: 28px; padding: 0 8px; font-size: 10px; }
.repository-workspace-sidebar-content { min-width: 0; min-height: 0; }
.repository-workspace-sidebar-content-inner { min-width: 0; padding: 7px; }
.repository-workspace-sidebar-content :deep([data-task-handoff-scroll-viewport] > div) { width: 100%; min-width: 0 !important; }
.repository-workspace-sidebar-content :deep([data-orientation="horizontal"]) { display: none; }
.repository-workspace-sidebar-state { display: flex; min-height: 100px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 11px; }
.repository-workspace-sidebar-state.error { color: var(--status-warning); }
.repository-workspace-main { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-tabs { display: flex; min-height: 38px; overflow-x: auto; overflow-y: hidden; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised, var(--background)); padding: 4px 5px 0; scrollbar-width: none; }
.repository-workspace-tabs::-webkit-scrollbar { display: none; }
.repository-workspace-tab { display: flex; min-width: 130px; max-width: 260px; align-items: stretch; border-bottom: 2px solid transparent; color: var(--text-muted); }
.repository-workspace-tab.active { border-bottom-color: var(--focus-ring); color: var(--text-strong); }
.repository-workspace-tab > [role="tab"] { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 6px; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px 0 9px; }
.repository-workspace-tab > [role="tab"] > span { flex: 1 1 auto; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-tab small { color: var(--text-muted); }
.repository-workspace-tab-close { display: grid; width: 26px; flex: 0 0 26px; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.repository-workspace-tab-close:hover, .repository-workspace-tab-close:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-tabs .repository-workspace-dirty { color: var(--status-warning); }
.repository-workspace-editor { display: grid; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-editor > header { display: flex; min-height: 48px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); padding: 0 13px; }
.repository-workspace-editor > header > span:first-child { display: grid; gap: 2px; }
.repository-workspace-editor header strong { font-size: 11px; }
.repository-workspace-editor header small { color: var(--text-muted); font-size: 9px; }
.repository-workspace-editor-actions { display: flex; align-items: center; gap: 6px; }
.repository-workspace-editor-actions :deep(button), .repository-workspace-stale-actions :deep(button) { gap: 5px; height: 28px; padding: 0 9px; font-size: 10px; }
.repository-workspace-editor-body { display: flex; min-height: 0; overflow: hidden; flex-direction: column; background: var(--workspace-bg); }
.repository-workspace-editor textarea { width: 100%; min-height: 0; flex: 1 1 auto; resize: none; border: 0; outline: none; background: var(--workspace-bg); color: var(--text); padding: 16px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; tab-size: 2; }
.repository-workspace-editor-error { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid color-mix(in srgb, var(--status-danger) 35%, transparent); background: color-mix(in srgb, var(--status-danger) 9%, transparent); color: var(--status-danger); padding: 8px 12px; font-size: 10px; }
.repository-workspace-stale { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid color-mix(in srgb, var(--status-warning) 35%, transparent); background: color-mix(in srgb, var(--status-warning) 9%, transparent); padding: 9px 12px; }
.repository-workspace-stale > div:first-child { display: flex; align-items: center; gap: 8px; color: var(--status-warning); }
.repository-workspace-stale > div:first-child span { display: grid; gap: 2px; }
.repository-workspace-stale strong { font-size: 11px; }
.repository-workspace-stale small { color: var(--text-muted); font-size: 9px; }
.repository-workspace-stale-actions { display: flex; gap: 6px; }
.repository-workspace-compare { display: grid; min-height: 0; flex: 1 1 auto; grid-template-columns: 1fr 1fr; overflow: hidden; }
.repository-workspace-compare section { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); border-right: 1px solid var(--line-subtle); }
.repository-workspace-compare section:last-child { border-right: 0; }
.repository-workspace-compare section > strong { border-bottom: 1px solid var(--line-subtle); color: var(--text-muted); padding: 7px 12px; font-size: 9px; text-transform: uppercase; }
.repository-workspace-compare pre { min-height: 0; margin: 0; overflow: auto; padding: 13px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre; }
.repository-workspace-empty { display: flex; min-height: 0; grid-row: 2; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); }
.repository-workspace-empty strong { color: var(--text-strong); font-size: 13px; }
.repository-workspace-empty span { font-size: 10px; }
.repository-workspace-spin { animation: repository-workspace-spin 0.9s linear infinite; }
:global([role="dialog"].repository-file-action-dialog) { width: min(480px, calc(100vw - 32px)); gap: 14px; border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.repository-file-action-form { display: grid; gap: 9px; }
.repository-file-action-form > label { color: var(--text-muted); font-size: 10px; font-weight: 700; }
.repository-file-action-form > p, .repository-file-action-error { margin: 0; color: var(--status-danger); font-size: 10px; }
.repository-file-action-form :deep(input) { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; }
.repository-file-action-form :deep(button), :global([role="dialog"].repository-file-action-dialog button) { gap: 6px; }
@keyframes repository-workspace-spin { to { transform: rotate(360deg); } }
@media (max-width: 800px) { .repository-workspace-body { grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .repository-workspace-spin { animation: none; } }
</style>
