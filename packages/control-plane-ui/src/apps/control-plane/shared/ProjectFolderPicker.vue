<template>
  <NodeStorageFolderPickerDialog
    :breadcrumbs="picker.breadcrumbs.value"
    :can-confirm="picker.canConfirm.value"
    :can-go-up="picker.canGoUp.value"
    :current-path="picker.currentPath.value"
    :error="picker.error.value"
    :loading="picker.loading.value"
    :node-name="nodeName"
    :open="open"
    :places="picker.places.value"
    :rows="picker.rows.value"
    :selected-path="picker.selectedPath.value"
    :submit-error="picker.submitError.value"
    :submitting="picker.submitting.value"
    @confirm="confirm"
    @navigate="picker.navigateTo"
    @refresh="picker.refresh"
    @select="picker.selectFolder"
    @up="picker.goUp"
    @update:open="setOpen"
  />
</template>

<script setup lang="ts">
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { createNodeLocalFolder, listNodeFolderPlaces, listNodeFolderTree } from "../../../api/queries";
import type { NodeLocalFolder } from "../../../api/types";
import NodeStorageFolderPickerDialog from "../settings/NodeStorageFolderPickerDialog.vue";
import { useNodeStorageFolderPicker } from "../settings/useNodeStorageFolderPicker";
import { translateApiError } from "../../../i18n/apiError";

const props = defineProps<{
  nodeId: string;
  nodeName: string;
  open: boolean;
}>();

const emit = defineEmits<{
  created: [folder: NodeLocalFolder];
  "update:open": [open: boolean];
}>();
const { t } = useI18n();

const picker = useNodeStorageFolderPicker({
  createFolder: async (nodeId, input) => {
    const folder = await createNodeLocalFolder(nodeId, input);
    emit("created", folder);
    return folder;
  },
  errorText: (error) => translateApiError(error, t),
  loadFolders: listNodeFolderTree,
  loadPlaces: listNodeFolderPlaces,
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
