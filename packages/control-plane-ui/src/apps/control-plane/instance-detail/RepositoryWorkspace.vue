<template>
  <component :is="embedded ? 'section' : Dialog" :open="embedded || open" :class="{ 'repository-workspace-embedded': embedded }" @update:open="$emit('update:open', $event)">
    <component :is="embedded ? 'div' : DialogContent" :class="['repository-workspace-dialog', { 'repository-workspace-window': standalone, 'repository-workspace-embedded-content': embedded }]" @open-auto-focus="focusWorkspace">
      <DialogTitle v-if="!embedded" class="sr-only">Repository workspace</DialogTitle>
      <DialogDescription v-if="!embedded" class="sr-only">Browse and edit repository files, inspect scoped changes, and perform confirmed Git mutations.</DialogDescription>
      <header class="repository-workspace-head">
        <span class="repository-workspace-title">
          <FolderGit2 :size="17" />
          <span><strong>{{ context.displayName || "Repository" }}</strong><small>{{ workspaceSubtitle }}</small></span>
        </span>
        <span class="repository-workspace-head-actions">
          <small v-if="popoutMessage" class="repository-workspace-popout-message" role="status">{{ popoutMessage }}</small>
          <button v-if="embedded" type="button" aria-label="Open repository workspace as dialog" title="Open as dialog" @click="emit('openDialog')"><Maximize2 :size="16" /></button>
          <button v-else-if="!standalone" type="button" aria-label="Return repository workspace to tab" title="Return to tab" @click="emit('openTab')"><PanelTop :size="16" /></button>
          <button v-if="!standalone" type="button" aria-label="Open repository workspace in new window" title="Open in new window" @click="openInNewWindow"><ExternalLink :size="16" /></button>
          <button v-if="!embedded" type="button" aria-label="Close repository workspace" title="Close" @click="emit('update:open', false)"><X :size="16" /></button>
        </span>
      </header>

      <div ref="workspaceBody" class="repository-workspace-body" :style="{ '--repository-sidebar-width': `${sidebarWidth}px` }">
        <aside class="repository-workspace-sidebar">
          <div ref="workspaceSidebarTabs" class="repository-workspace-sidebar-tabs" role="tablist" aria-label="Repository navigation" @keydown="navigateSidebarTabs">
            <button type="button" role="tab" data-repository-view="files" :tabindex="sidebarView === 'files' ? 0 : -1" :aria-selected="sidebarView === 'files'" :class="{ active: sidebarView === 'files' }" @click="sidebarView = 'files'"><Files :size="14" /><span>Files</span></button>
            <button type="button" role="tab" data-repository-view="changes" :tabindex="sidebarView === 'changes' ? 0 : -1" :aria-selected="sidebarView === 'changes'" :class="{ active: sidebarView === 'changes' }" @click="sidebarView = 'changes'"><GitCompareArrows :size="14" /><span>Changes</span><b v-if="changeCount">{{ changeCount }}</b></button>
          </div>
          <div class="repository-workspace-sidebar-actions">
            <Button v-if="sidebarView === 'files'" variant="ghost" size="sm" @click="openNewFileDialog"><FilePlus2 :size="13" /> New file</Button>
            <template v-else>
              <span>{{ selectedChanges.length ? `${selectedChanges.length} selected` : "Select files to update the index" }}</span>
              <Button v-if="canStageSelection" variant="ghost" size="sm" :disabled="changeMutationPending" title="Stage selected files" @click="stageSelection"><ListPlus :size="13" /> Stage</Button>
              <Button v-if="canUnstageSelection" variant="ghost" size="sm" :disabled="changeMutationPending" title="Unstage selected files" @click="unstageSelection"><ListMinus :size="13" /> Unstage</Button>
              <Button v-if="canDiscardWorktreeSelection || canDiscardAllSelection" variant="ghost" size="sm" :disabled="changeMutationPending" title="Discard selected changes" @click="openDiscardDialog"><RotateCcw :size="13" /> Discard</Button>
              <Button variant="ghost" size="sm" :disabled="changeMutationPending || !stagedCount" title="Commit current index" @click="openCommitDialog"><GitCommitHorizontal :size="13" /> Commit</Button>
            </template>
          </div>
          <ScrollArea type="always" class="repository-workspace-sidebar-content">
            <div class="repository-workspace-sidebar-content-inner">
            <RepositoryErrorNotice v-if="changeMutationError && sidebarView === 'changes'" :error="changeMutationError" fallback="Repository changes could not be updated." />
            <div v-if="changeMutationSuccess && sidebarView === 'changes'" class="repository-change-mutation-message success" role="status"><CheckCircle2 :size="14" /><span>{{ changeMutationSuccess }}</span></div>
            <div v-if="loadingWorkspace" class="repository-workspace-sidebar-state"><LoaderCircle class="repository-workspace-spin" :size="16" /> Loading repository…</div>
            <RepositoryErrorNotice v-else-if="workspaceError" :error="workspaceError" fallback="Failed to load repository workspace." />
            <RepositoryFileTree
              v-else-if="sidebarView === 'files'"
              :directories="directories"
              :expanded-paths="expandedPaths"
              path=""
              @open-file="openFile"
              @toggle-directory="toggleDirectory"
            />
            <div v-else class="repository-changes-tree">
              <section v-for="group in changeGroups" :key="group.scope">
                <h3><span>{{ group.label }}</span><b>{{ group.entries.length }}</b></h3>
                <small v-if="group.scope === 'conflict' && group.entries.length" class="repository-conflict-guidance">Resolve conflicts before commit, pull, or push.</small>
                <div v-for="entry in group.entries" :key="`${entry.scope}:${entry.path}`" class="repository-change-row" :data-selected="isChangeSelected(entry) ? 'true' : undefined">
                  <Checkbox :model-value="isChangeSelected(entry)" :aria-label="`Select ${entry.scope} change ${entry.path}`" @update:model-value="toggleChange(entry, $event)" />
                  <button type="button" :title="entry.path" @click="openDiff(entry)">
                    <TriangleAlert v-if="entry.scope === 'conflict'" :size="13" />
                    <FileDiff v-else :size="13" />
                    <span>{{ entry.path }}</span>
                    <small>{{ statusLabel(entry.status) }}</small>
                  </button>
                </div>
              </section>
            </div>
            </div>
          </ScrollArea>
        </aside>

        <div class="repository-workspace-resize-handle" role="separator" aria-label="Resize repository sidebar" aria-orientation="vertical" :aria-valuenow="Math.round(sidebarWidth)" tabindex="0" @pointerdown="startSidebarResize" @dblclick="sidebarWidth = 320" @keydown.left.prevent="setSidebarWidth(sidebarWidth - 16)" @keydown.right.prevent="setSidebarWidth(sidebarWidth + 16)" />

        <main class="repository-workspace-main">
          <div v-if="tabs.length" ref="workspaceOpenTabs" class="repository-workspace-tabs" role="tablist" aria-label="Open repository files" @keydown="navigateOpenTabs" @wheel="scrollOpenTabs">
            <div v-for="tab in tabs" :key="tab.id" class="repository-workspace-tab" :class="{ active: activeTabId === tab.id }">
              <button type="button" role="tab" :data-repository-tab="tab.id" :tabindex="activeTabId === tab.id ? 0 : -1" :aria-selected="activeTabId === tab.id" @click="activeTabId = tab.id">
                <FileDiff v-if="tab.kind === 'diff'" :size="13" /><FileCode2 v-else :size="13" />
                <span>{{ tab.path }}<small v-if="tab.kind === 'diff'"> · {{ tab.scope }}</small><small v-else-if="tab.draft !== tab.content" class="repository-workspace-dirty"> · unsaved</small></span>
              </button>
              <button type="button" class="repository-workspace-tab-close" :aria-label="`Close ${tab.path}`" @click="closeTab(tab.id)"><X :size="12" /></button>
            </div>
          </div>
          <section v-if="activeTab?.kind === 'file'" class="repository-workspace-editor">
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
          <section v-else-if="activeTab?.kind === 'diff'" class="repository-workspace-diff">
            <header>
              <span><strong>{{ activeTab.path }}</strong><small>{{ activeTab.scope }} diff</small></span>
              <span class="repository-workspace-diff-actions">
                <span class="repository-workspace-diff-flags"><b v-if="activeTab.binary">Binary</b><b v-if="activeTab.truncated">Truncated</b><b v-else-if="activeTab.complete">Complete</b></span>
                <Button variant="outline" size="sm" @click="openFile({ path: activeTab.path })"><FilePenLine :size="13" /> Open working file</Button>
              </span>
            </header>
            <div v-if="activeTab.binary" class="repository-workspace-empty"><FileWarning :size="30" /><strong>Binary diff cannot be displayed.</strong><span>Open the file with an appropriate tool in the session environment.</span></div>
            <div v-else class="repository-workspace-diff-body">
              <div v-if="activeTab.truncated" class="repository-workspace-diff-warning" role="status"><FileWarning :size="15" /><span><strong>Incomplete diff</strong><small>Only the first {{ activeTab.byteLimit }} bytes are shown. Inspect the complete patch in the session terminal.</small></span></div>
              <pre>{{ activeTab.content }}</pre>
            </div>
          </section>
          <section v-else class="repository-workspace-empty">
            <FolderOpen :size="38" />
            <strong>Open a file or change</strong>
            <span>Browse repository-relative files or inspect a scoped diff.</span>
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

      <Dialog v-model:open="discardDialogOpen">
        <DialogContent class="repository-file-action-dialog repository-discard-dialog">
          <DialogHeader><DialogTitle>Discard selected changes?</DialogTitle><DialogDescription>Only the {{ selectedChanges.length }} selected tracked file{{ selectedChanges.length === 1 ? "" : "s" }} will be changed. This does not delete untracked files or create a stash.</DialogDescription></DialogHeader>
          <div class="repository-discard-paths"><span v-for="entry in selectedChanges" :key="changeId(entry)">{{ entry.scope }} · {{ entry.path }}</span></div>
          <RepositoryErrorNotice v-if="changeMutationError" :error="changeMutationError" fallback="Selected changes could not be discarded." />
          <DialogFooter class="repository-discard-cancel"><Button data-discard-cancel variant="outline" :disabled="changeMutationPending" @click="discardDialogOpen = false">Cancel</Button></DialogFooter>
          <div class="repository-discard-options">
            <button v-if="canDiscardWorktreeSelection" type="button" :disabled="changeMutationPending" @click="discardSelected('worktree')"><RotateCcw :size="16" /><span><strong>Discard worktree changes</strong><small>Restore worktree content from the index. Existing staged content is retained.</small></span></button>
            <button v-if="canDiscardAllSelection" type="button" :disabled="changeMutationPending" @click="discardSelected('all-tracked')"><Trash2 :size="16" /><span><strong>Discard all tracked changes</strong><small>Restore both the index and worktree content from HEAD for these files.</small></span></button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="commitDialogOpen">
        <DialogContent class="repository-file-action-dialog repository-commit-dialog">
          <DialogHeader><DialogTitle>Commit staged changes</DialogTitle><DialogDescription>This commits the current index only. Unstaged and untracked files are not added automatically.</DialogDescription></DialogHeader>
          <form class="repository-file-action-form" @submit.prevent="commitIndex">
            <label for="repository-commit-message">Commit message · {{ stagedCount }} staged</label>
            <Textarea id="repository-commit-message" v-model="commitMessage" rows="5" placeholder="Describe the staged change" />
            <RepositoryErrorNotice v-if="commitError" :error="commitError" fallback="Staged changes could not be committed." />
            <DialogFooter><Button type="button" variant="outline" :disabled="changeMutationPending" @click="commitDialogOpen = false">Cancel</Button><Button type="submit" :disabled="changeMutationPending || !commitMessage.trim()"><LoaderCircle v-if="changeMutationPending" class="repository-workspace-spin" :size="13" /><GitCommitHorizontal v-else :size="13" />{{ changeMutationPending ? "Committing…" : "Commit index" }}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </component>
  </component>
</template>

<script setup lang="ts">
import type {
  RepositoryChangeEntry,
  RepositoryChangeScope,
  RepositoryContext,
  RepositoryDiff,
  RepositoryDirectoryEntry,
  RepositoryDirectoryListing,
  RepositoryFileContent,
  RepositoryFileMutationResult,
  RepositoryMutationResult,
  RepositorySessionKind,
} from "@task-handoff/protocol/repository";
import { CheckCircle2, CircleAlert, Columns2, ExternalLink, FileCode2, FileDiff, FilePenLine, FilePlus2, Files, FileWarning, FolderGit2, FolderOpen, GitCommitHorizontal, GitCompareArrows, ListMinus, ListPlus, LoaderCircle, Maximize2, PanelTop, PencilLine, RefreshCw, RotateCcw, Save, Trash2, TriangleAlert, X } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError } from "../../../api/client";
import { commitRepositoryIndex, createRepositoryFile, deleteRepositoryFile, discardRepositoryAllTracked, discardRepositoryWorktree, getRepositoryChanges, getRepositoryContext, getRepositoryDiff, getRepositoryDirectory, getRepositoryFile, renameRepositoryFile, stageRepositoryPaths, unstageRepositoryPaths, writeRepositoryFile } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
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
type DiffTab = RepositoryDiff & { id: string; kind: "diff" };
type WorkspaceTab = FileTab | DiffTab;

const props = defineProps<{
  context: RepositoryContext;
  embedded?: boolean;
  initialView: "files" | "changes";
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  standalone?: boolean;
}>();

const emit = defineEmits<{
  openDialog: [];
  openTab: [];
  "update:open": [open: boolean];
}>();

const queryClient = useQueryClient();
const target = computed(() => ({ instanceId: props.instanceId, sessionKind: props.sessionKind, sessionId: props.sessionId }));
const sidebarView = ref<"files" | "changes">("files");
const directories = ref<Map<string, RepositoryDirectoryListing>>(new Map());
const expandedPaths = ref<Set<string>>(new Set());
const changes = ref<Awaited<ReturnType<typeof getRepositoryChanges>>>();
const tabs = ref<WorkspaceTab[]>([]);
const activeTabId = ref("");
const workspaceSidebarTabs = ref<HTMLElement>();
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
const selectedChangeIds = ref<Set<string>>(new Set());
const changeMutationPending = ref(false);
const changeMutationError = ref<unknown>();
const changeMutationSuccess = ref("");
const discardDialogOpen = ref(false);
const commitDialogOpen = ref(false);
const commitMessage = ref("");
const commitError = ref<unknown>();
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value));
const changeCount = computed(() => changes.value?.entries.length || 0);
const changeGroups = computed(() => ([
  { scope: "conflict", label: "Conflicts" },
  { scope: "staged", label: "Staged" },
  { scope: "unstaged", label: "Unstaged" },
  { scope: "untracked", label: "Untracked" },
] as const).map((group) => ({ ...group, entries: changes.value?.entries.filter((entry) => entry.scope === group.scope) || [] })));
const selectedChanges = computed(() => (changes.value?.entries || []).filter((entry) => selectedChangeIds.value.has(changeId(entry))));
const stagedCount = computed(() => changes.value?.entries.filter((entry) => entry.scope === "staged").length || 0);
const canStageSelection = computed(() => selectedChanges.value.length > 0 && selectedChanges.value.every((entry) => ["unstaged", "untracked", "conflict"].includes(entry.scope)));
const canUnstageSelection = computed(() => selectedChanges.value.length > 0 && selectedChanges.value.every((entry) => entry.scope === "staged"));
const canDiscardWorktreeSelection = computed(() => selectedChanges.value.length > 0 && selectedChanges.value.every((entry) => entry.scope === "unstaged"));
const canDiscardAllSelection = computed(() => selectedChanges.value.length > 0
  && props.context.head?.state !== "unborn"
  && selectedChanges.value.every((entry) => entry.scope === "staged" || entry.scope === "unstaged"));
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
    const opened = await openRepositoryWorkspaceWindow({ ...target.value, view: sidebarView.value });
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
  void nextTick(() => workspaceSidebarTabs.value?.querySelector<HTMLButtonElement>(`[data-repository-view="${sidebarView.value}"]`)?.focus());
}

function navigateSidebarTabs(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const nextView = event.key === "ArrowLeft" || event.key === "Home" ? "files" : "changes";
  sidebarView.value = nextView;
  void nextTick(() => workspaceSidebarTabs.value?.querySelector<HTMLButtonElement>(`[data-repository-view="${nextView}"]`)?.focus());
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
  sidebarView.value = props.initialView;
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
    selectedChangeIds.value = new Set();
    changeMutationError.value = undefined;
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

async function openDiff(entry: RepositoryChangeEntry) {
  const id = `diff:${entry.scope}:${entry.path}`;
  const existing = tabs.value.find((tab) => tab.id === id);
  if (existing) { activeTabId.value = id; return; }
  try {
    const diff = await getRepositoryDiff(target.value, { path: entry.path, scope: entry.scope as RepositoryChangeScope });
    tabs.value.push({ ...diff, id, kind: "diff" });
    activeTabId.value = id;
  } catch (error) {
    workspaceError.value = error;
  }
}

function changeId(entry: RepositoryChangeEntry) {
  return `${entry.scope}:${entry.path}`;
}

function isChangeSelected(entry: RepositoryChangeEntry) {
  return selectedChangeIds.value.has(changeId(entry));
}

function toggleChange(entry: RepositoryChangeEntry, checked: boolean | "indeterminate") {
  const next = new Set(selectedChangeIds.value);
  if (checked === true) next.add(changeId(entry));
  else next.delete(changeId(entry));
  selectedChangeIds.value = next;
}

function versionedPaths(entries: RepositoryChangeEntry[]) {
  return entries.map((entry) => ({ path: entry.path, expectedVersion: entry.version }));
}

function discardAllPaths() {
  const selectedPaths = new Set(selectedChanges.value.map((entry) => entry.path));
  const result: { path: string; expectedVersion: string }[] = [];
  for (const path of selectedPaths) {
    const current = changes.value?.entries.find((entry) => entry.path === path && (entry.scope === "staged" || entry.scope === "unstaged"));
    if (current) result.push({ path: current.path, expectedVersion: current.version });
  }
  return result;
}

async function stageSelection() {
  if (!canStageSelection.value || changeMutationPending.value) return;
  await runChangeMutation("Staged selected files.", selectedChanges.value.map((entry) => entry.path), () => stageRepositoryPaths(target.value, {
    paths: versionedPaths(selectedChanges.value),
    expectedSnapshotId: requireSnapshotId(),
  }));
}

async function unstageSelection() {
  if (!canUnstageSelection.value || changeMutationPending.value) return;
  await runChangeMutation("Unstaged selected files.", selectedChanges.value.map((entry) => entry.path), () => unstageRepositoryPaths(target.value, {
    paths: versionedPaths(selectedChanges.value),
    expectedSnapshotId: requireSnapshotId(),
  }));
}

function openDiscardDialog() {
  if (!canDiscardWorktreeSelection.value && !canDiscardAllSelection.value) return;
  changeMutationError.value = undefined;
  discardDialogOpen.value = true;
}

async function discardSelected(mode: "worktree" | "all-tracked") {
  const paths = mode === "worktree" ? versionedPaths(selectedChanges.value) : discardAllPaths();
  const selectedPaths = paths.map((entry) => entry.path);
  await runChangeMutation(
    mode === "worktree" ? "Discarded selected worktree changes; staged content was retained." : "Discarded all selected tracked changes to HEAD.",
    selectedPaths,
    () => mode === "worktree"
      ? discardRepositoryWorktree(target.value, { paths, expectedSnapshotId: requireSnapshotId(), confirm: true })
      : discardRepositoryAllTracked(target.value, { paths, expectedSnapshotId: requireSnapshotId(), confirm: true }),
  );
  if (!changeMutationError.value) discardDialogOpen.value = false;
}

function openCommitDialog() {
  if (!stagedCount.value) return;
  commitMessage.value = "";
  commitError.value = undefined;
  commitDialogOpen.value = true;
}

async function commitIndex() {
  if (!commitMessage.value.trim() || !stagedCount.value || changeMutationPending.value) return;
  changeMutationPending.value = true;
  commitError.value = undefined;
  changeMutationSuccess.value = "";
  try {
    const result = await commitRepositoryIndex(target.value, { message: commitMessage.value, expectedSnapshotId: requireSnapshotId() });
    await applyRepositoryMutation(result, []);
    selectedChangeIds.value = new Set();
    commitDialogOpen.value = false;
    changeMutationSuccess.value = result.commitOid ? `Committed ${result.commitOid.slice(0, 10)}.` : "Committed staged changes.";
  } catch (error) {
    commitError.value = error;
    if (isStale(error)) await refreshRepositoryState();
  } finally {
    changeMutationPending.value = false;
  }
}

async function runChangeMutation(
  successMessage: string,
  affectedPaths: string[],
  mutation: () => Promise<RepositoryMutationResult>,
) {
  changeMutationPending.value = true;
  changeMutationError.value = undefined;
  changeMutationSuccess.value = "";
  try {
    const result = await mutation();
    await applyRepositoryMutation(result, affectedPaths);
    selectedChangeIds.value = new Set();
    changeMutationSuccess.value = successMessage;
  } catch (error) {
    changeMutationError.value = error;
    if (isStale(error)) await refreshRepositoryState();
  } finally {
    changeMutationPending.value = false;
  }
}

async function applyRepositoryMutation(result: RepositoryMutationResult, affectedPaths: string[]) {
  if (result.changes) changes.value = result.changes;
  else await refreshRepositoryState();
  queryClient.setQueryData(repositoryContextQueryKey(), result.context);
  if (affectedPaths.length) {
    const affected = new Set(affectedPaths);
    const removedIds = new Set(tabs.value.filter((tab) => tab.kind === "diff" && affected.has(tab.path)).map((tab) => tab.id));
    tabs.value = tabs.value.filter((tab) => !removedIds.has(tab.id));
    if (removedIds.has(activeTabId.value)) activeTabId.value = tabs.value.at(-1)?.id || "";
  }
  await refreshLoadedDirectories();
  notifyRepositoryChanged();
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

function statusLabel(status: RepositoryChangeEntry["status"]) {
  return ({ added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", unmerged: "U", untracked: "?" })[status];
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
.repository-workspace-popout-message { max-width: 300px; overflow: hidden; margin-right: 6px; color: var(--status-warning); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-body { display: grid; min-height: 0; grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); overflow: hidden; }
.repository-workspace-sidebar { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); background: var(--surface-raised, var(--background)); }
.repository-workspace-resize-handle { position: relative; z-index: 2; cursor: col-resize; background: transparent; touch-action: none; }
.repository-workspace-resize-handle::after { position: absolute; top: 0; bottom: 0; left: 2.5px; width: 2px; background: var(--line-subtle); content: ""; }
.repository-workspace-resize-handle:hover::after, :global(body.repository-sidebar-resizing) .repository-workspace-resize-handle::after { background: var(--focus-ring); }
:global(body.repository-sidebar-resizing) { cursor: col-resize; user-select: none; }
.repository-workspace-sidebar-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; border-bottom: 1px solid var(--line-subtle); padding: 7px; }
.repository-workspace-sidebar-tabs button { display: flex; min-height: 31px; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 11px; }
.repository-workspace-sidebar-tabs button.active { background: var(--surface-subtle); color: var(--text-strong); }
.repository-workspace-sidebar-tabs b { min-width: 18px; border-radius: 999px; background: var(--workspace-bg); font-size: 9px; line-height: 18px; }
.repository-workspace-sidebar-actions { display: flex; min-height: 38px; align-items: center; justify-content: flex-end; border-bottom: 1px solid var(--line-subtle); padding: 4px 7px; }
.repository-workspace-sidebar-actions > span { min-width: 0; margin-right: auto; overflow: hidden; color: var(--text-muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.repository-workspace-sidebar-actions :deep(button) { gap: 5px; height: 28px; padding: 0 8px; font-size: 10px; }
.repository-workspace-sidebar-content { min-width: 0; min-height: 0; }
.repository-workspace-sidebar-content-inner { min-width: 0; padding: 7px; }
.repository-workspace-sidebar-content :deep([data-task-handoff-scroll-viewport] > div) { width: 100%; min-width: 0 !important; }
.repository-workspace-sidebar-content :deep([data-orientation="horizontal"]) { display: none; }
.repository-workspace-sidebar-state { display: flex; min-height: 100px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 11px; }
.repository-workspace-sidebar-state.error { color: var(--status-warning); }
.repository-changes-tree { display: grid; gap: 9px; }
.repository-changes-tree section { display: grid; gap: 2px; }
.repository-changes-tree h3 { display: flex; justify-content: space-between; margin: 0; color: var(--text-muted); padding: 4px 6px; font-size: 10px; text-transform: uppercase; }
.repository-conflict-guidance { color: var(--status-warning); padding: 0 6px 4px; font-size: 9px; line-height: 1.4; }
.repository-change-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 3px; border-radius: 5px; padding-left: 5px; }
.repository-change-row[data-selected="true"] { background: color-mix(in srgb, var(--focus-ring) 10%, transparent); }
.repository-change-row :deep([role="checkbox"]) { width: 14px; height: 14px; border-color: var(--line-strong); }
.repository-changes-tree button { display: grid; width: 100%; min-height: 29px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 3px 6px; text-align: left; }
.repository-changes-tree button:hover, .repository-changes-tree button:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-changes-tree button span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.repository-changes-tree button small { font-size: 9px; font-weight: 800; }
.repository-change-mutation-message { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; border: 1px solid var(--line-subtle); border-radius: 6px; padding: 7px; font-size: 9px; }
.repository-change-mutation-message.error { border-color: color-mix(in srgb, var(--status-danger) 35%, var(--line-subtle)); color: var(--status-danger); }
.repository-change-mutation-message.success { border-color: color-mix(in srgb, var(--status-success) 35%, var(--line-subtle)); color: var(--status-success); }
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
.repository-workspace-editor, .repository-workspace-diff { display: grid; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-editor > header, .repository-workspace-diff > header { display: flex; min-height: 48px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line-subtle); padding: 0 13px; }
.repository-workspace-editor > header > span:first-child, .repository-workspace-diff > header > span:first-child { display: grid; gap: 2px; }
.repository-workspace-editor header strong, .repository-workspace-diff header strong { font-size: 11px; }
.repository-workspace-editor header small, .repository-workspace-diff header small { color: var(--text-muted); font-size: 9px; }
.repository-workspace-editor-actions, .repository-workspace-diff-actions { display: flex; align-items: center; gap: 6px; }
.repository-workspace-editor-actions :deep(button), .repository-workspace-diff-actions :deep(button), .repository-workspace-stale-actions :deep(button) { gap: 5px; height: 28px; padding: 0 9px; font-size: 10px; }
.repository-workspace-readonly, .repository-workspace-diff-flags { color: var(--text-muted); font-size: 9px; text-transform: uppercase; }
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
.repository-workspace-diff-body { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-workspace-diff pre { min-width: 0; min-height: 0; margin: 0; overflow: auto; background: var(--workspace-bg); color: var(--text); padding: 16px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre; }
.repository-workspace-diff-warning { display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid color-mix(in srgb, var(--status-warning) 30%, var(--line-subtle)); background: color-mix(in srgb, var(--status-warning) 7%, var(--workspace-bg)); color: var(--status-warning); padding: 9px 13px; }
.repository-workspace-diff-warning > span { display: grid; gap: 2px; }
.repository-workspace-diff-warning strong { font-size: 10px; }
.repository-workspace-diff-warning small { color: var(--text-muted); font-size: 9px; }
.repository-workspace-diff-flags { display: flex; gap: 5px; }
.repository-workspace-diff-flags b { border-radius: 999px; background: var(--surface-subtle); padding: 3px 7px; }
.repository-workspace-empty { display: flex; min-height: 0; grid-row: 2; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); }
.repository-workspace-empty strong { color: var(--text-strong); font-size: 13px; }
.repository-workspace-empty span { font-size: 10px; }
.repository-workspace-spin { animation: repository-workspace-spin 0.9s linear infinite; }
:global([role="dialog"].repository-file-action-dialog) { width: min(480px, calc(100vw - 32px)); gap: 14px; border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.repository-file-action-form { display: grid; gap: 9px; }
.repository-file-action-form > label { color: var(--text-muted); font-size: 10px; font-weight: 700; }
.repository-file-action-form > p, .repository-file-action-error { margin: 0; color: var(--status-danger); font-size: 10px; }
.repository-file-action-form :deep(input) { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; }
.repository-file-action-form :deep(textarea) { min-height: 110px; resize: vertical; font-size: 11px; }
.repository-file-action-form :deep(button), :global([role="dialog"].repository-file-action-dialog button) { gap: 6px; }
.repository-discard-paths { display: flex; max-height: 120px; overflow: auto; flex-wrap: wrap; gap: 5px; }
.repository-discard-paths span { border-radius: 999px; background: var(--surface-subtle); color: var(--text-muted); padding: 3px 7px; font: 9px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.repository-discard-options { display: grid; gap: 7px; }
.repository-discard-options { order: 3; }
.repository-discard-cancel { order: 4; }
.repository-discard-options > button { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 9px; border: 1px solid color-mix(in srgb, var(--status-danger) 30%, var(--line-subtle)); border-radius: 8px; background: transparent; color: var(--status-danger); cursor: pointer; padding: 10px; text-align: left; }
.repository-discard-options > button:hover, .repository-discard-options > button:focus-visible { background: color-mix(in srgb, var(--status-danger) 8%, transparent); }
.repository-discard-options > button:disabled { cursor: not-allowed; opacity: 0.55; }
.repository-discard-options > button span { display: grid; gap: 3px; }
.repository-discard-options > button strong { font-size: 11px; }
.repository-discard-options > button small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }
@keyframes repository-workspace-spin { to { transform: rotate(360deg); } }
@media (max-width: 800px) { .repository-workspace-body { grid-template-columns: minmax(220px, var(--repository-sidebar-width)) 7px minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .repository-workspace-spin { animation: none; } }
</style>
