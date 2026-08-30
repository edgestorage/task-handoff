import { computed, ref } from "vue";
import type { NodeFolderTreeEntry } from "../../api/types";
import { flattenFolderTree, folderTreeNode, type NodeFolderTreeNode } from "./new-instance/nodeFolderTree.ts";
import { nodePathBreadcrumbs, nodePathParent } from "./nodePath.ts";
import { translateApiError } from "../../i18n/apiError.ts";
import type { Translate } from "../../i18n/status.ts";

type NodeFolderTreeLoader = (nodeId: string, input: { path?: string; depth?: number }) => Promise<NodeFolderTreeEntry[]>;

type UseNodeFolderBrowserOptions = {
  errorText?: (error: unknown) => string;
  load: NodeFolderTreeLoader;
  onSelect?: (path: string) => void;
  presentation?: "tree" | "directory";
  translate?: Translate;
};

export function useNodeFolderBrowser(options: UseNodeFolderBrowserOptions) {
  const load = options.load;
  const roots = ref<NodeFolderTreeNode[]>([]);
  const selectedPath = ref("");
  const currentPath = ref("");
  const loading = ref(false);
  const error = ref("");
  const rows = computed(() => flattenFolderTree(roots.value));
  const breadcrumbs = computed(() => nodePathBreadcrumbs(currentPath.value));
  const canGoUp = computed(() => Boolean(nodePathParent(currentPath.value)));
  const revision = ref(0);
  let activeNodeId = "";
  let requestGeneration = 0;

  function displayError(cause: unknown) {
    const fallback = options.errorText
      ? options.errorText(cause)
      : cause instanceof Error
        ? cause.message
        : String(cause);
    return options.translate ? translateApiError(cause, options.translate, fallback) : fallback;
  }

  function reset() {
    requestGeneration += 1;
    activeNodeId = "";
    roots.value = [];
    selectedPath.value = "";
    currentPath.value = "";
    loading.value = false;
    error.value = "";
  }

  async function loadRoots(nodeId: string) {
    if (!nodeId) {
      reset();
      return;
    }
    const generation = ++requestGeneration;
    activeNodeId = nodeId;
    loading.value = true;
    error.value = "";
    try {
      const entries = await load(nodeId, { depth: 0 });
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      if (options.presentation === "directory" && entries[0]) {
        await loadDirectory(nodeId, entries[0].path, generation);
      } else {
        roots.value = entries.map((entry) => folderTreeNode(entry, 0));
      }
    } catch (cause) {
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      error.value = displayError(cause);
    } finally {
      if (generation === requestGeneration && activeNodeId === nodeId) {
        loading.value = false;
      }
    }
  }

  async function selectFolder(folder: NodeFolderTreeNode) {
    if (options.presentation === "directory") {
      await navigateTo(folder.path);
      return;
    }
    selectedPath.value = folder.path;
    options.onSelect?.(folder.path);
    if (folder.loading) return;
    if (folder.loaded) {
      folder.expanded = !folder.expanded;
      return;
    }
    if (!activeNodeId) return;

    const nodeId = activeNodeId;
    const generation = requestGeneration;
    folder.loading = true;
    error.value = "";
    try {
      const [entry] = await load(nodeId, { path: folder.path, depth: 1 });
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      folder.children = (entry?.children || []).map((child) => folderTreeNode(child, folder.depth + 1));
      folder.loaded = true;
      folder.expanded = true;
    } catch (cause) {
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      error.value = displayError(cause);
    } finally {
      if (generation === requestGeneration && activeNodeId === nodeId) {
        folder.loading = false;
      }
    }
  }

  async function loadDirectory(nodeId: string, path: string, generation: number) {
    const [entry] = await load(nodeId, { path, depth: 1 });
    if (generation !== requestGeneration || activeNodeId !== nodeId) return;
    currentPath.value = entry?.path || path;
    selectedPath.value = currentPath.value;
    roots.value = (entry?.children || []).map((child) => folderTreeNode(child, 0));
    options.onSelect?.(selectedPath.value);
  }

  async function navigateTo(path: string) {
    const nodeId = activeNodeId;
    if (!nodeId || !path.trim()) return;
    revision.value += 1;
    const generation = ++requestGeneration;
    loading.value = true;
    error.value = "";
    try {
      await loadDirectory(nodeId, path.trim(), generation);
    } catch (cause) {
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      error.value = displayError(cause);
    } finally {
      if (generation === requestGeneration && activeNodeId === nodeId) loading.value = false;
    }
  }

  async function goUp() {
    const parent = nodePathParent(currentPath.value);
    if (parent) await navigateTo(parent);
  }

  async function refresh() {
    if (!activeNodeId) return;
    if (options.presentation === "directory" && currentPath.value) {
      await navigateTo(currentPath.value);
      return;
    }
    await loadRoots(activeNodeId);
  }

  return {
    breadcrumbs,
    canGoUp,
    currentPath,
    error,
    goUp,
    loadRoots,
    loading,
    navigateTo,
    refresh,
    revision,
    reset,
    roots,
    rows,
    selectedPath,
    selectFolder,
  };
}
