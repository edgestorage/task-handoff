<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="node-storage-folder-picker-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("settings.nodeDialogs.addLocalFolder", { name: nodeName }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.nodeDialogs.selectDirectory") }}</DialogDescription>
      </DialogHeader>

      <div class="node-storage-folder-picker-body">
        <label>
          <span>{{ t("settings.nodeDialogs.selectedPath") }}</span>
          <ControlPlaneInput :model-value="selectedPath" :placeholder="t('settings.nodeDialogs.selectFolderBelow')" readonly />
        </label>
        <NodeFolderTree
          :error="error"
          :loading="loading"
          :rows="rows"
          :selected-path="selectedPath"
          @refresh="$emit('refresh')"
          @select="$emit('select', $event)"
        />
        <p v-if="submitError" class="control-plane-error">{{ submitError }}</p>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="submitting" @click="$emit('update:open', false)">{{ t("settings.nodeDialogs.cancel") }}</Button>
        <Button type="button" :disabled="!canConfirm" @click="$emit('confirm')">
          <FolderPlus :size="15" />
          <span>{{ submitting ? t("settings.nodeDialogs.adding") : t("settings.nodeDialogs.addFolder") }}</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { FolderPlus } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import NodeFolderTree from "../new-instance/NodeFolderTree.vue";
import type { NodeFolderTreeNode } from "../new-instance/nodeFolderTree";

const { t } = useI18n();

defineProps<{
  canConfirm: boolean;
  error: string;
  loading: boolean;
  nodeName: string;
  open: boolean;
  rows: NodeFolderTreeNode[];
  selectedPath: string;
  submitError: string;
  submitting: boolean;
}>();

defineEmits<{
  confirm: [];
  refresh: [];
  select: [folder: NodeFolderTreeNode];
  "update:open": [open: boolean];
}>();
</script>

<style scoped>
:global(.node-storage-folder-picker-dialog) {
  width: min(720px, calc(100vw - 32px)) !important;
  max-width: calc(100vw - 32px) !important;
  max-height: calc(100vh - 32px);
  overflow: hidden;
}

.node-storage-folder-picker-body {
  display: grid;
  min-height: 0;
  gap: 12px;
}

.node-storage-folder-picker-body > label {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.node-storage-folder-picker-body > label > span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.node-storage-folder-picker-body :deep(.node-folder-tree-list) {
  max-height: min(360px, calc(100vh - 360px));
}
</style>
