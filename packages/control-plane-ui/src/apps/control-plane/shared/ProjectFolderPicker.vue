<template>
  <NodeStorageFolderPickerDialog
    :can-confirm="picker.canConfirm.value"
    :error="picker.error.value"
    :loading="picker.loading.value"
    :node-name="nodeName"
    :open="open"
    :rows="picker.rows.value"
    :selected-path="picker.selectedPath.value"
    :submit-error="picker.submitError.value"
    :submitting="picker.submitting.value"
    @confirm="confirm"
    @refresh="picker.loadRoots(nodeId)"
    @select="picker.selectFolder"
    @update:open="setOpen"
  />
</template>

<script setup lang="ts">
import { watch } from "vue";
import { createNodeLocalFolder, listNodeFolderTree } from "../../../api/queries";
import type { NodeLocalFolder } from "../../../api/types";
import NodeStorageFolderPickerDialog from "../settings/NodeStorageFolderPickerDialog.vue";
import { useNodeStorageFolderPicker } from "../settings/useNodeStorageFolderPicker";

const props = defineProps<{
  nodeId: string;
  nodeName: string;
  open: boolean;
}>();

const emit = defineEmits<{
  created: [folder: NodeLocalFolder];
  "update:open": [open: boolean];
}>();

const picker = useNodeStorageFolderPicker({
  createFolder: async (nodeId, input) => {
    const folder = await createNodeLocalFolder(nodeId, input);
    emit("created", folder);
    return folder;
  },
  errorText: (error) => error instanceof Error ? error.message : String(error),
  loadFolders: listNodeFolderTree,
  refresh: async () => undefined,
});

watch(
  () => [props.open, props.nodeId, props.nodeName] as const,
  ([open, nodeId, nodeName]) => {
    if (open) {
      void picker.openForNode({ id: nodeId, name: nodeName });
      return;
    }
    picker.setOpen(false);
  },
  { immediate: true },
);

function setOpen(open: boolean) {
  if (!open) picker.setOpen(false);
  emit("update:open", open);
}

async function confirm() {
  if (await picker.confirm()) {
    emit("update:open", false);
  }
}
</script>
