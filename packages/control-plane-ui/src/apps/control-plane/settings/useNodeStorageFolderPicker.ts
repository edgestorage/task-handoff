import { computed, ref } from "vue";
import type { NodeFolderTreeEntry, NodeLocalFolder } from "../../../api/types";
import { nodePathName } from "../nodePath.ts";
import { useNodeFolderBrowser } from "../useNodeFolderBrowser.ts";

type NodeFolderTreeLoader = (nodeId: string, input: { path?: string; depth?: number }) => Promise<NodeFolderTreeEntry[]>;
type CreateNodeFolder = (nodeId: string, input: { name: string; path: string }) => Promise<NodeLocalFolder>;

type UseNodeStorageFolderPickerOptions = {
  createFolder: CreateNodeFolder;
  errorText: (error: unknown) => string;
  loadFolders: NodeFolderTreeLoader;
  refresh: () => Promise<void>;
};

export function useNodeStorageFolderPicker(options: UseNodeStorageFolderPickerOptions) {
  const dialogOpen = ref(false);
  const targetNode = ref<{ id: string; name: string }>();
  const submitting = ref(false);
  const submitError = ref("");
  let dialogGeneration = 0;
  const browser = useNodeFolderBrowser({
    errorText: options.errorText,
    load: options.loadFolders,
  });

  const canConfirm = computed(() => Boolean(targetNode.value && browser.selectedPath.value.trim() && !submitting.value));

  async function openForNode(node: { id: string; name: string }) {
    dialogGeneration += 1;
    browser.reset();
    targetNode.value = { id: node.id, name: node.name };
    submitError.value = "";
    dialogOpen.value = true;
    await browser.loadRoots(node.id);
  }

  function close() {
    dialogGeneration += 1;
    dialogOpen.value = false;
    targetNode.value = undefined;
    submitting.value = false;
    submitError.value = "";
    browser.reset();
  }

  function setOpen(open: boolean) {
    if (!open) close();
  }

  async function confirm() {
    const node = targetNode.value;
    const path = browser.selectedPath.value.trim();
    if (!node || !path || submitting.value) return false;

    const generation = dialogGeneration;
    submitting.value = true;
    submitError.value = "";
    try {
      await options.createFolder(node.id, {
        name: nodePathName(path),
        path,
      });
    } catch (error) {
      if (generation === dialogGeneration) {
        submitError.value = options.errorText(error);
        submitting.value = false;
      }
      return false;
    }
    if (generation === dialogGeneration) close();
    await options.refresh().catch(() => undefined);
    return true;
  }

  return {
    ...browser,
    canConfirm,
    close,
    confirm,
    dialogOpen,
    openForNode,
    setOpen,
    submitError,
    submitting,
    targetNode,
  };
}
