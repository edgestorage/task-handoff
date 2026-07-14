import { computed, ref } from "vue";
import type { NodeFolderTreeEntry } from "../../api/types";
import { flattenFolderTree, folderTreeNode, type NodeFolderTreeNode } from "./new-instance/nodeFolderTree.ts";

type NodeFolderTreeLoader = (nodeId: string, input: { path?: string; depth?: number }) => Promise<NodeFolderTreeEntry[]>;

type UseNodeFolderBrowserOptions = {
  errorText?: (error: unknown) => string;
  load: NodeFolderTreeLoader;
  onSelect?: (path: string) => void;
};

export function useNodeFolderBrowser(options: UseNodeFolderBrowserOptions) {
  const load = options.load;
  const roots = ref<NodeFolderTreeNode[]>([]);
  const selectedPath = ref("");
  const loading = ref(false);
  const error = ref("");
  const rows = computed(() => flattenFolderTree(roots.value));
  let activeNodeId = "";
  let requestGeneration = 0;

  function reset() {
    requestGeneration += 1;
    activeNodeId = "";
    roots.value = [];
    selectedPath.value = "";
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
      roots.value = entries.map((entry) => folderTreeNode(entry, 0));
    } catch (cause) {
      if (generation !== requestGeneration || activeNodeId !== nodeId) return;
      error.value = options.errorText ? options.errorText(cause) : cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === requestGeneration && activeNodeId === nodeId) {
        loading.value = false;
      }
    }
  }

  async function selectFolder(folder: NodeFolderTreeNode) {
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
      error.value = options.errorText ? options.errorText(cause) : cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === requestGeneration && activeNodeId === nodeId) {
        folder.loading = false;
      }
    }
  }

  return {
    error,
    loadRoots,
    loading,
    reset,
    roots,
    rows,
    selectedPath,
    selectFolder,
  };
}
