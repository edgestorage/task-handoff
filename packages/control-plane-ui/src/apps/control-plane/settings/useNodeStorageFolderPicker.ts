import { computed, ref } from "vue";
import type { NodeFolderPlace, NodeFolderTreeEntry, NodeLocalFolder } from "../../../api/types";
import { nodePathName } from "../nodePath.ts";
import { useNodeFolderBrowser } from "../useNodeFolderBrowser.ts";
import { translateApiError } from "../../../i18n/apiError.ts";
import type { Translate } from "../../../i18n/status.ts";

type NodeFolderTreeLoader = (nodeId: string, input: { path?: string; depth?: number }) => Promise<NodeFolderTreeEntry[]>;
type NodeFolderPlacesLoader = (nodeId: string) => Promise<NodeFolderPlace[]>;
type CreateNodeFolder = (nodeId: string, input: { name: string; path: string }) => Promise<NodeLocalFolder>;

type UseNodeStorageFolderPickerOptions = {
  createFolder: CreateNodeFolder;
  errorText: (error: unknown) => string;
  loadFolders: NodeFolderTreeLoader;
  loadPlaces: NodeFolderPlacesLoader;
  refresh: () => Promise<void>;
  translate?: Translate;
};

export function useNodeStorageFolderPicker(options: UseNodeStorageFolderPickerOptions) {
  const translateError = (error: unknown) => options.translate
    ? translateApiError(error, options.translate, options.errorText(error))
    : options.errorText(error);
  const dialogOpen = ref(false);
  const targetNode = ref<{ id: string; name: string }>();
  const submitting = ref(false);
  const submitError = ref("");
  const places = ref<NodeFolderPlace[]>([]);
  let dialogGeneration = 0;
  const browser = useNodeFolderBrowser({
    errorText: options.errorText,
    load: options.loadFolders,
    presentation: "directory",
    translate: options.translate,
  });

  const canConfirm = computed(() => Boolean(targetNode.value && browser.selectedPath.value.trim() && !submitting.value));

  async function openForNode(node: { id: string; name: string }) {
    const generation = ++dialogGeneration;
    browser.reset();
    targetNode.value = { id: node.id, name: node.name };
    submitError.value = "";
    dialogOpen.value = true;
    const initialBrowserRevision = browser.revision.value;
    const placesRequest = options.loadPlaces(node.id).catch(() => []);
    await browser.loadRoots(node.id);
    if (generation !== dialogGeneration || !dialogOpen.value || targetNode.value?.id !== node.id) return;
    const loadedPlaces = await placesRequest;
    if (generation !== dialogGeneration || !dialogOpen.value || targetNode.value?.id !== node.id) return;
    places.value = loadedPlaces;
    const home = loadedPlaces.find((place) => place.kind === "home");
    if (home && browser.revision.value === initialBrowserRevision) await browser.navigateTo(home.path);
  }

  function close() {
    dialogGeneration += 1;
    dialogOpen.value = false;
    targetNode.value = undefined;
    submitting.value = false;
    submitError.value = "";
    places.value = [];
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
        submitError.value = translateError(error);
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
    places,
    setOpen,
    submitError,
    submitting,
    targetNode,
  };
}
