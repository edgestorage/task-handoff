<template>
  <section class="repository-workspace">
    <div class="repository-workspace-content">
      <header class="repository-workspace-head">
        <div
          ref="pathBar"
          class="repository-workspace-path"
          :data-expanded="breadcrumbExpanded ? 'true' : undefined"
          :data-picker-open="openBreadcrumbIndex === undefined ? undefined : 'true'"
          @focusin="setBreadcrumbExpanded(true)"
          @focusout="setBreadcrumbExpanded(false)"
          @mouseenter="setBreadcrumbExpanded(true)"
          @mouseleave="setBreadcrumbExpanded(false)"
          @wheel="scrollBreadcrumb"
        >
          <template v-for="(segment, index) in breadcrumbSegments" :key="`${index}:${segment.directoryPath}:${segment.label}`">
            <ChevronRight
              v-if="index"
              class="repository-workspace-path-separator"
              :data-collapsed="isCollapsedBreadcrumbSeparator(index) ? 'true' : undefined"
              :size="14"
            />
            <RepositoryFilePicker
              :open="openBreadcrumbIndex === index"
              :search="fileSearch"
              :search-disabled="!pathSearchSupported"
              :search-label="t('repository.workspace.searchFiles')"
              :search-placeholder="t(pathSearchSupported ? 'repository.workspace.searchFiles' : 'repository.workspace.searchUnavailable')"
              @update:open="updateBreadcrumbPicker(index, segment, $event)"
              @update:search="fileSearch = $event"
            >
              <template #trigger>
                <button
                  type="button"
                  class="repository-workspace-path-segment"
                  :data-collapsed="isCollapsedBreadcrumb(index) ? 'true' : undefined"
                  :data-collapsed-first="isCollapsedBreadcrumbFirst(index) ? 'true' : undefined"
                  :data-current="index === breadcrumbSegments.length - 1 ? 'true' : undefined"
                  :title="segment.title"
                >{{ segment.label }}</button>
              </template>
              <template #actions>
                <Button variant="ghost" size="icon" :aria-label="t('repository.workspace.newFile')" :title="t('repository.workspace.newFile')" @click="openNewFileDialog"><FilePlus2 :size="14" /></Button>
              </template>
              <RepositoryWorkspaceFileList
                :directory-load-error="directoryLoadError"
                :loading="loadingWorkspace || searchLoading"
                :nodes="workspaceTreeNodes"
                :search-error="searchError"
                :searching="searchLoading"
                :search-query="normalizedFileSearch"
                :search-truncated="searchResult?.truncated"
                :workspace-load-error="workspaceLoadError"
                @select="selectWorkspaceTreeNode"
                @toggle="toggleWorkspaceTreeNode"
              />
            </RepositoryFilePicker>
          </template>
        </div>
        <span class="repository-workspace-head-actions">
          <Button v-if="activeTab" variant="ghost" size="icon" :disabled="fileActionPending" :aria-label="t('repository.workspace.rename')" :title="t('repository.workspace.rename')" @click="openRenameDialog(activeTab)"><PencilLine :size="14" /></Button>
          <Button v-if="activeTab" variant="ghost" size="icon" :disabled="fileActionPending" :aria-label="t('repository.workspace.delete')" :title="t('repository.workspace.delete')" @click="openDeleteDialog(activeTab)"><Trash2 :size="14" /></Button>
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

      <div class="repository-workspace-body" tabindex="-1">
        <main class="repository-workspace-main">
          <section v-if="fileOpenError" class="repository-workspace-editor repository-workspace-file-error">
            <div class="repository-workspace-editor-body repository-workspace-file-error-body">
              <RepositoryErrorNotice :error="fileOpenError.error" :fallback="t('repository.errors.fileLoad')" />
            </div>
          </section>
          <section v-else-if="activeTab" class="repository-workspace-editor">
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
  RepositoryPathSearchResult,
  RepositorySessionKind,
} from "@task-handoff/protocol/repository";
import { ChevronRight, FilePlus2, FolderOpen, GitCompareArrows, LoaderCircle, PencilLine, Trash2 } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "../../../api/client";
import { createRepositoryFile, deleteRepositoryFile, getRepositoryChanges, getRepositoryContext, getRepositoryDirectory, getRepositoryFile, renameRepositoryFile, searchRepositoryPaths } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import RepositoryFilePicker from "./RepositoryFilePicker.vue";
import RepositoryFilePreview from "./RepositoryFilePreview.vue";
import type { RepositoryFileTreeNode } from "./RepositoryFileTree.vue";
import RepositoryWorkspaceFileList from "./RepositoryWorkspaceFileList.vue";
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

type RepositoryBreadcrumbSegment = {
  directoryPath: string;
  label: string;
  title: string;
};

const props = defineProps<{
  context: RepositoryContext;
  instanceId: string;
  initialFilePath?: string;
  initialFileRequestId?: number;
  pathSearchSupported: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>();
const { t } = useI18n();

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
const pickerRootPath = ref("");
const openBreadcrumbIndex = ref<number>();
const pathBar = ref<HTMLElement>();
const breadcrumbExpanded = ref(false);
const breadcrumbFirstCollapsedIndex = ref<number>();
const fileSearch = ref("");
const searchResult = ref<RepositoryPathSearchResult>();
const searchLoading = ref(false);
const searchError = ref<unknown>();
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
const currentFilePath = computed(() => activeTab.value?.path || fileOpenError.value?.path || "");
const breadcrumbSegments = computed<RepositoryBreadcrumbSegment[]>(() => {
  const rootLabel = props.context.displayName || t("repository.title");
  const root = { directoryPath: "", label: rootLabel, title: props.context.repositoryRoot || rootLabel };
  if (!currentFilePath.value) return [root, { directoryPath: "", label: t("repository.workspace.openFile"), title: t("repository.workspace.openFile") }];
  const parts = currentFilePath.value.split("/");
  return [root, ...parts.map((label, index) => {
    const path = parts.slice(0, index + 1).join("/");
    const directoryPath = index === parts.length - 1 ? parentPath(path) : path;
    return { directoryPath, label, title: path };
  })];
});
const changeCount = computed(() => changes.value?.entries.length || 0);
const normalizedFileSearch = computed(() => fileSearch.value.trim());
const workspaceTreeNodes = computed<RepositoryFileTreeNode[]>(() => {
  if (normalizedFileSearch.value && props.pathSearchSupported) {
    return (searchResult.value?.entries || []).map((entry) => ({
      id: `search:${entry.path}`,
      path: entry.path,
      name: entry.name,
      description: parentPath(entry.path),
      kind: entry.kind,
      depth: 0,
      selectable: true,
      active: entry.kind === "file" && activeTab.value?.path === entry.path,
    }));
  }
  return flattenLoadedDirectories(pickerRootPath.value);
});

async function updateBreadcrumbPicker(index: number, segment: RepositoryBreadcrumbSegment, nextOpen: boolean) {
  if (!nextOpen) {
    if (openBreadcrumbIndex.value === index) openBreadcrumbIndex.value = undefined;
    return;
  }
  pickerRootPath.value = segment.directoryPath;
  openBreadcrumbIndex.value = index;
  fileSearch.value = "";
  searchResult.value = undefined;
  searchError.value = undefined;
  directoryLoadError.value = undefined;
  if (directories.value.has(segment.directoryPath)) return;
  try {
    const listing = await getRepositoryDirectory(target.value, segment.directoryPath);
    directories.value = new Map(directories.value).set(segment.directoryPath, listing);
  } catch (error) {
    if (pickerRootPath.value === segment.directoryPath) directoryLoadError.value = { path: segment.directoryPath, error };
  }
}

function scrollBreadcrumb(event: WheelEvent) {
  const element = event.currentTarget as HTMLElement;
  if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  element.scrollLeft += event.deltaY;
  event.preventDefault();
}

function scrollBreadcrumbTo(offset: number) {
  void nextTick(() => {
    if (pathBar.value) pathBar.value.scrollLeft = offset;
  });
}

function setBreadcrumbExpanded(next: boolean) {
  if (breadcrumbExpanded.value === next) return;
  breadcrumbExpanded.value = next;
  if (next) scrollBreadcrumbTo(0);
}

// Collapsed breadcrumb segments are measured against the available width so that every
// segment that fits stays readable and only the overflowing middle collapses into an ellipsis.
const BREADCRUMB_SEGMENT_PADDING = 10;
const BREADCRUMB_SEPARATOR_WIDTH = 14;
const BREADCRUMB_ELLIPSIS_WIDTH = 34;

let breadcrumbMeasureElement: HTMLSpanElement | undefined;

function measureBreadcrumbLabel(label: string, sample: HTMLElement | undefined) {
  if (!breadcrumbMeasureElement) {
    breadcrumbMeasureElement = document.createElement("span");
    breadcrumbMeasureElement.setAttribute("aria-hidden", "true");
    breadcrumbMeasureElement.style.cssText = "position:absolute;top:0;left:-10000px;visibility:hidden;white-space:pre;pointer-events:none;";
    document.body.append(breadcrumbMeasureElement);
  }
  const style = sample ? getComputedStyle(sample) : undefined;
  const fontSize = style && Number.parseFloat(style.fontSize) > 0 ? style.fontSize : "12px";
  breadcrumbMeasureElement.style.fontFamily = style?.fontFamily || "system-ui";
  breadcrumbMeasureElement.style.fontSize = fontSize;
  breadcrumbMeasureElement.style.fontStyle = style?.fontStyle || "normal";
  breadcrumbMeasureElement.style.fontWeight = style?.fontWeight || "400";
  breadcrumbMeasureElement.style.letterSpacing = style?.letterSpacing || "normal";
  breadcrumbMeasureElement.textContent = label;
  return breadcrumbMeasureElement.getBoundingClientRect().width + BREADCRUMB_SEGMENT_PADDING;
}

function updateBreadcrumbCollapse() {
  const element = pathBar.value;
  const segments = breadcrumbSegments.value;
  if (!element || element.clientWidth <= 0) return;
  const lastIndex = segments.length - 1;
  if (segments.length <= 2) {
    breadcrumbFirstCollapsedIndex.value = undefined;
    return;
  }
  const rendered = element.querySelectorAll<HTMLElement>(".repository-workspace-path-segment");
  const widths = segments.map((segment, index) => measureBreadcrumbLabel(segment.label, rendered[index]));
  const available = element.clientWidth;
  const fullWidth = widths.reduce((total, width) => total + width, 0) + lastIndex * BREADCRUMB_SEPARATOR_WIDTH;
  if (fullWidth <= available) {
    breadcrumbFirstCollapsedIndex.value = undefined;
    return;
  }
  const tailWidth = BREADCRUMB_ELLIPSIS_WIDTH + 2 * BREADCRUMB_SEPARATOR_WIDTH + widths[lastIndex];
  let leadingWidth = 0;
  let firstCollapsed = 0;
  for (let index = 0; index < lastIndex; index += 1) {
    const nextWidth = leadingWidth + (index ? BREADCRUMB_SEPARATOR_WIDTH : 0) + widths[index];
    if (nextWidth + tailWidth > available) break;
    leadingWidth = nextWidth;
    firstCollapsed = index + 1;
  }
  breadcrumbFirstCollapsedIndex.value = firstCollapsed;
}

function isCollapsedBreadcrumb(index: number) {
  const first = breadcrumbFirstCollapsedIndex.value;
  return first !== undefined && index >= first && index < breadcrumbSegments.value.length - 1;
}

function isCollapsedBreadcrumbFirst(index: number) {
  return breadcrumbFirstCollapsedIndex.value === index;
}

function isCollapsedBreadcrumbSeparator(index: number) {
  const first = breadcrumbFirstCollapsedIndex.value;
  return first !== undefined && index > first && index < breadcrumbSegments.value.length - 1;
}

watch(openBreadcrumbIndex, (index) => {
  if (index !== undefined) scrollBreadcrumbTo(0);
});

watch(currentFilePath, () => {
  if (!breadcrumbExpanded.value && openBreadcrumbIndex.value === undefined) scrollBreadcrumbTo(0);
}, { immediate: true });

watch(breadcrumbSegments, () => {
  void nextTick(updateBreadcrumbCollapse);
});

let breadcrumbResizeObserver: ResizeObserver | undefined;

onMounted(() => {
  updateBreadcrumbCollapse();
  if (document.fonts) void document.fonts.ready.then(() => updateBreadcrumbCollapse());
  if (typeof ResizeObserver === "undefined" || !pathBar.value) return;
  breadcrumbResizeObserver = new ResizeObserver(() => updateBreadcrumbCollapse());
  breadcrumbResizeObserver.observe(pathBar.value);
});

onBeforeUnmount(() => {
  breadcrumbResizeObserver?.disconnect();
  breadcrumbResizeObserver = undefined;
  breadcrumbMeasureElement?.remove();
  breadcrumbMeasureElement = undefined;
});

watch(() => `${props.instanceId}:${props.sessionKind}:${props.sessionId}`, () => {
  void loadWorkspace();
}, { immediate: true });

watch(fileSearch, (value, _previous, onCleanup) => {
  searchResult.value = undefined;
  searchError.value = undefined;
  const query = value.trim();
  if (!query || !props.pathSearchSupported) {
    searchLoading.value = false;
    return;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(async () => {
    searchLoading.value = true;
    try {
      searchResult.value = await searchRepositoryPaths(target.value, query, 100, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) searchError.value = error;
    } finally {
      if (!controller.signal.aborted) searchLoading.value = false;
    }
  }, 180);
  onCleanup(() => {
    window.clearTimeout(timer);
    controller.abort();
  });
});

watch(openBreadcrumbIndex, (index) => {
  if (index !== undefined) return;
  fileSearch.value = "";
  searchResult.value = undefined;
  searchError.value = undefined;
});

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

function flattenLoadedDirectories(path = "", depth = 0, result: RepositoryFileTreeNode[] = []) {
  for (const entry of directories.value.get(path)?.entries || []) {
    result.push({
      id: `browse:${entry.path}`,
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      depth,
      expandable: entry.traversable,
      expanded: entry.traversable && expandedPaths.value.has(entry.path),
      selectable: entry.kind === "file",
      active: entry.kind === "file" && activeTab.value?.path === entry.path,
    });
    if (entry.traversable && expandedPaths.value.has(entry.path)) flattenLoadedDirectories(entry.path, depth + 1, result);
  }
  return result;
}

function toggleWorkspaceTreeNode(node: RepositoryFileTreeNode) {
  const entry = directoryEntry(node.path);
  if (entry) void toggleDirectory(entry);
}

function selectWorkspaceTreeNode(node: RepositoryFileTreeNode) {
  if (node.kind === "directory") {
    void revealDirectory(node.path);
    return;
  }
  openBreadcrumbIndex.value = undefined;
  void openFile({ path: node.path });
}

async function revealDirectory(relativePath: string) {
  directoryLoadError.value = undefined;
  const nextExpanded = new Set(expandedPaths.value);
  let current = "";
  for (const segment of relativePath.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (!directories.value.has(current)) {
      try {
        const listing = await getRepositoryDirectory(target.value, current);
        directories.value = new Map(directories.value).set(current, listing);
      } catch (error) {
        directoryLoadError.value = { path: current, error };
        return;
      }
    }
    nextExpanded.add(current);
  }
  expandedPaths.value = nextExpanded;
  fileSearch.value = "";
}

function directoryEntry(relativePath: string) {
  const parent = parentPath(relativePath);
  return directories.value.get(parent)?.entries.find((entry) => entry.path === relativePath);
}

function parentPath(relativePath: string) {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? "" : relativePath.slice(0, index);
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
  openBreadcrumbIndex.value = undefined;
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
.repository-workspace { display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; container-type: inline-size; }
.repository-workspace-content { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--workspace-bg, var(--background)); color: var(--text); }
.repository-workspace-head { display: flex; min-width: 0; min-height: 40px; align-items: center; gap: 4px; border-bottom: 1px solid var(--line-subtle); padding: 4px 6px 4px 10px; }
.repository-workspace-path { display: flex; height: 30px; min-width: 0; flex: 1 1 auto; align-items: center; overflow-x: auto; overflow-y: hidden; color: var(--text-muted); scrollbar-width: none; }
.repository-workspace-path::-webkit-scrollbar { display: none; }
.repository-workspace-path-separator { flex: 0 0 auto; opacity: 0.72; }
.repository-workspace-path-segment { height: 28px; min-width: max-content; flex: 0 0 auto; overflow: visible; border: 0; border-radius: 4px; outline: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; line-height: 1; padding: 0 5px; white-space: nowrap; }
.repository-workspace-path-segment[data-collapsed="true"] { max-width: 0; min-width: 0; overflow: hidden; opacity: 0; padding-inline: 0; pointer-events: none; transition: max-width 180ms ease, padding-inline 180ms ease, opacity 140ms ease; }
.repository-workspace-path-segment[data-collapsed="true"][data-collapsed-first="true"] { max-width: 24px; padding-inline: 5px; opacity: 1; pointer-events: auto; font-size: 0; }
.repository-workspace-path-segment[data-collapsed="true"][data-collapsed-first="true"]::after { content: "..."; font-size: 12px; }
.repository-workspace-path-separator[data-collapsed="true"] { width: 0; overflow: hidden; transition: width 180ms ease, opacity 140ms ease; }
.repository-workspace-path[data-picker-open] .repository-workspace-path-segment[data-collapsed="true"],
.repository-workspace-path[data-expanded] .repository-workspace-path-segment[data-collapsed="true"] { max-width: 320px; opacity: 1; padding-inline: 5px; pointer-events: auto; font-size: 12px; }
.repository-workspace-path[data-picker-open] .repository-workspace-path-segment[data-collapsed="true"][data-collapsed-first="true"]::after,
.repository-workspace-path[data-expanded] .repository-workspace-path-segment[data-collapsed="true"][data-collapsed-first="true"]::after { content: none; }
.repository-workspace-path[data-picker-open] .repository-workspace-path-separator[data-collapsed="true"],
.repository-workspace-path[data-expanded] .repository-workspace-path-separator[data-collapsed="true"] { width: 14px; opacity: 0.72; }
.repository-workspace-path-segment:hover, .repository-workspace-path-segment:focus-visible, .repository-workspace-path-segment[data-state="open"] { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-path-segment:focus-visible { box-shadow: inset 0 0 0 1px var(--focus-ring); }
.repository-workspace-path-segment[data-current="true"] { flex: 0 1 auto; color: var(--text-strong); font-weight: 500; }
.repository-workspace-path:not([data-expanded]):not([data-picker-open]) .repository-workspace-path-segment[data-current="true"] { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.repository-workspace-head-actions { display: flex; min-width: max-content; flex: 0 0 auto; align-items: center; gap: 2px; }
.repository-workspace-head-actions > button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; }
.repository-workspace-head-actions > button:hover, .repository-workspace-head-actions > button:focus-visible { background: var(--surface-subtle); color: var(--text); }
.repository-workspace-head-actions :deep(.repository-workspace-view-switch) { display: inline-flex; width: auto; min-width: 30px; height: 30px; align-items: center; justify-content: center; gap: 5px; padding: 0 7px; white-space: nowrap; }
.repository-workspace-view-count { display: inline-flex; min-width: 19px; height: 18px; align-items: center; justify-content: center; border: 1px solid var(--line-subtle); border-radius: 999px; background: var(--surface-subtle); color: var(--text); font-size: 11px; font-weight: 600; line-height: 1; padding: 0 5px; }
.repository-workspace-body { min-width: 0; min-height: 0; overflow: hidden; }
.repository-workspace-main { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: minmax(0, 1fr); }
.repository-workspace-editor { display: grid; min-height: 0; grid-template-rows: minmax(0, 1fr); }
.repository-workspace-editor-body { display: flex; min-height: 0; overflow: hidden; flex-direction: column; background: var(--workspace-bg); }
.repository-workspace-file-error-body { align-items: center; justify-content: center; padding: 24px; }
.repository-workspace-file-error-body :deep(.repository-error-notice) { width: min(680px, 100%); }
.repository-workspace-empty { display: flex; min-height: 0; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--text-muted); }
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
@media (prefers-reduced-motion: reduce) { .repository-workspace-spin { animation: none; } }
</style>
