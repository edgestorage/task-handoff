import { computed, ref } from "vue";
import type { Node, UpdateNodeInput } from "../../../api/types.ts";

export const NODE_NAME_MAX_LENGTH = 160;

type UseNodeRenameInput = {
  errorText: (error: unknown) => string;
  nodes: () => Node[];
  notify: (message: string, kind?: "error" | "success") => void;
  onNodeRenamed: (node: Node) => void | Promise<void>;
  updateNode: (id: string, input: UpdateNodeInput) => Promise<Node>;
};

export function useNodeRename({ errorText, nodes, notify, onNodeRenamed, updateNode }: UseNodeRenameInput) {
  const nodeRenameOpen = ref(false);
  const nodeRenameTargetId = ref("");
  const nodeRenameDraft = ref("");
  const nodeRenameError = ref("");
  const renamingNodeId = ref("");
  const canSubmitNodeRename = computed(() => {
    const target = nodes().find((node) => node.id === nodeRenameTargetId.value);
    const name = nodeRenameDraft.value.trim();
    return Boolean(nodeRenameOpen.value && target && !renamingNodeId.value && name && name.length <= NODE_NAME_MAX_LENGTH && name !== target.name);
  });

  function resetNodeRename() {
    nodeRenameOpen.value = false;
    nodeRenameTargetId.value = "";
    nodeRenameDraft.value = "";
    nodeRenameError.value = "";
  }

  function openNodeRename(target: Pick<Node, "id" | "name">) {
    if (renamingNodeId.value) return;
    nodeRenameTargetId.value = target.id;
    nodeRenameDraft.value = target.name;
    nodeRenameError.value = "";
    nodeRenameOpen.value = true;
  }

  function setNodeRenameOpen(open: boolean) {
    if (!open) {
      if (!renamingNodeId.value) resetNodeRename();
      return;
    }
    nodeRenameOpen.value = true;
  }

  function updateNodeRenameDraft(value: string) {
    nodeRenameDraft.value = value;
    nodeRenameError.value = "";
  }

  async function submitNodeRename() {
    if (!nodeRenameOpen.value || renamingNodeId.value) return;
    const target = nodes().find((node) => node.id === nodeRenameTargetId.value);
    if (!target) {
      nodeRenameError.value = "The selected node is no longer available.";
      return;
    }
    const name = nodeRenameDraft.value.trim();
    if (!name) {
      nodeRenameError.value = "Node name is required.";
      return;
    }
    if (name.length > NODE_NAME_MAX_LENGTH) {
      nodeRenameError.value = `Node name must be ${NODE_NAME_MAX_LENGTH} characters or fewer.`;
      return;
    }
    if (name === target.name) {
      nodeRenameError.value = "Enter a different node name.";
      return;
    }

    renamingNodeId.value = target.id;
    nodeRenameError.value = "";
    try {
      const renamed = await updateNode(target.id, { name });
      await onNodeRenamed(renamed);
      resetNodeRename();
      notify(`${renamed.name} renamed.`, "success");
    } catch (error) {
      nodeRenameError.value = errorText(error);
    } finally {
      renamingNodeId.value = "";
    }
  }

  return {
    canSubmitNodeRename,
    nodeRenameDraft,
    nodeRenameError,
    nodeRenameOpen,
    nodeRenameTargetId,
    openNodeRename,
    renamingNodeId,
    resetNodeRename,
    setNodeRenameOpen,
    submitNodeRename,
    updateNodeRenameDraft,
  };
}
