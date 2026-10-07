<template>
  <component
    :is="itemComponent"
    v-if="canShowInstanceAction(instance, 'start')"
    class="instance-action-item"
    :disabled="isInstanceActionBusy(instance)"
    @select="emit('runAction', 'start')"
  >
    <Play :size="14" />
    <span>{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
  </component>
  <component
    :is="itemComponent"
    v-if="canShowInstanceAction(instance, 'stop')"
    class="instance-action-item"
    :disabled="isInstanceActionBusy(instance)"
    @select="emit('runAction', 'stop')"
  >
    <Square :size="14" />
    <span>{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
  </component>
  <component
    :is="itemComponent"
    v-if="canShowInstanceAction(instance, 'restart')"
    class="instance-action-item"
    :disabled="isInstanceActionBusy(instance)"
    @select="emit('runAction', 'restart')"
  >
    <RotateCw :size="14" />
    <span>{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
  </component>
  <component
    :is="itemComponent"
    v-if="provisioningRetry"
    class="instance-action-item"
    :disabled="isInstanceActionBusy(instance)"
    @select="emit('runAction', provisioningRetry.action)"
  >
    <RotateCw :size="14" />
    <span>{{ activeActionLabel(instance, provisioningRetry.action, provisioningRetry.label) }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item" @select="emit('openConfigSync', 'import')">
    <Download :size="14" />
    <span>{{ t("instances.actions.importConfig") }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item" :disabled="!canExportConfig(instance)" @select="emit('openConfigSync', 'export')">
    <Upload :size="14" />
    <span>{{ t("instances.actions.exportConfig") }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item" @select="emit('openSettings')">
    <Settings :size="14" />
    <span>{{ t("navigation.settings") }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item" @select="emit('openWindow')">
    <ExternalLink :size="14" />
    <span>{{ t("instances.window.openInNewWindow") }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item" :disabled="instance.runtime?.type !== 'docker' || isInstanceActionBusy(instance)" @select="emit('saveTemplate')">
    <PackagePlus :size="14" />
    <span>{{ t("instances.actions.saveEnvironmentTemplate") }}</span>
  </component>
  <component :is="separatorComponent" class="instance-action-separator" />
  <component :is="itemComponent" class="instance-action-item danger" :disabled="!aiSessionCount(instance) || isInstanceActionBusy(instance) || isClosingAllSessions(instance)" @select="emit('closeAllSessions')">
    <CircleX :size="14" />
    <span>{{ t(isClosingAllSessions(instance) ? "instances.actions.closingAllSessions" : "instances.actions.closeAllSessions") }}</span>
  </component>
  <component :is="itemComponent" class="instance-action-item danger" :disabled="isInstanceActionBusy(instance)" @select="emit('runAction', 'delete')">
    <Trash2 :size="14" />
    <span>{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</span>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ContextMenuItem, ContextMenuSeparator } from "../../../components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "../../../components/ui/dropdown-menu";
import { CircleX, Download, ExternalLink, PackagePlus, Play, RotateCw, Settings, Square, Trash2, Upload } from "@lucide/vue";
import type { InstanceBoardItem } from "../../../api/types";
import type { ConfigSyncDirection } from "@task-handoff/protocol/config-sync";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction, instanceProvisioningRetryAction, instanceProvisioningRetryLabel } from "../useInstanceStatus";

const { t } = useI18n();
const props = defineProps<{
  instance: InstanceBoardItem;
  variant: "dropdown" | "context";
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  canExportConfig: (instance: InstanceBoardItem) => boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  isClosingAllSessions: (instance: InstanceBoardItem) => boolean;
  aiSessionCount: (instance: InstanceBoardItem) => number;
}>();
const emit = defineEmits<{
  runAction: [action: InstanceAction];
  openConfigSync: [direction: ConfigSyncDirection];
  openSettings: [];
  openWindow: [];
  saveTemplate: [];
  closeAllSessions: [];
}>();
const itemComponent = computed(() => props.variant === "context" ? ContextMenuItem : DropdownMenuItem);
const separatorComponent = computed(() => props.variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator);
// Image and Git preparation are sequential, so a failed instance owns exactly
// one retry; surface it as a single menu item.
const provisioningRetry = computed(() => {
  const action = instanceProvisioningRetryAction(props.instance);
  return action ? { action, label: instanceProvisioningRetryLabel(props.instance, t) } : undefined;
});
</script>
