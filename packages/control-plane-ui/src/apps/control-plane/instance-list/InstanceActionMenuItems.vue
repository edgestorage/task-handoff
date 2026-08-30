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
    v-if="canShowInstanceAction(instance, 'retry-image')"
    class="instance-action-item"
    :disabled="isInstanceActionBusy(instance)"
    @select="emit('runAction', 'retry-image')"
  >
    <RotateCw :size="14" />
    <span>{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
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
  <component :is="itemComponent" class="instance-action-item danger" :disabled="isInstanceActionBusy(instance)" @select="emit('runAction', 'delete')">
    <Trash2 :size="14" />
    <span>{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</span>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ContextMenuItem } from "../../../components/ui/context-menu";
import { DropdownMenuItem } from "../../../components/ui/dropdown-menu";
import { Download, ExternalLink, PackagePlus, Play, RotateCw, Settings, Square, Trash2, Upload } from "@lucide/vue";
import type { InstanceBoardItem } from "../../../api/types";
import type { ConfigSyncDirection } from "@task-handoff/protocol/config-sync";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction } from "../useInstanceStatus";

const { t } = useI18n();
const props = defineProps<{
  instance: InstanceBoardItem;
  variant: "dropdown" | "context";
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  canExportConfig: (instance: InstanceBoardItem) => boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
}>();
const emit = defineEmits<{
  runAction: [action: InstanceAction];
  openConfigSync: [direction: ConfigSyncDirection];
  openSettings: [];
  openWindow: [];
  saveTemplate: [];
}>();
const itemComponent = computed(() => props.variant === "context" ? ContextMenuItem : DropdownMenuItem);
</script>
