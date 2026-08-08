<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="environment-template-settings">
      <header class="environment-template-head">
        <div>
          <strong>{{ t("settings.environmentTemplateRegistry.title") }}</strong>
          <span>{{ t("settings.environmentTemplateRegistry.description") }}</span>
        </div>
        <ControlPlaneSelect v-model="nodeId" :placeholder="t('settings.environmentTemplateRegistry.selectNode')">
          <ControlPlaneSelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </header>

      <label class="environment-template-search">
        <Search :size="14" />
        <input v-model="search" type="search" :placeholder="t('settings.environmentTemplateRegistry.search')" />
      </label>

      <div v-if="templates.isLoading.value" class="environment-template-empty">{{ t("settings.environmentTemplateRegistry.loading") }}</div>
      <div v-else-if="templates.error.value" class="environment-template-error" role="alert">
        <AlertTriangle :size="16" />
        <span>{{ t("settings.environmentTemplateRegistry.nodeUnavailable") }}</span>
        <Button variant="outline" size="sm" @click="templates.refetch()"><RefreshCw :size="14" />{{ t("common.actions.retry") }}</Button>
      </div>
      <div v-else class="environment-template-list">
        <article v-for="template in filteredTemplates" :key="template.id" class="environment-template-row">
          <Package :size="18" />
          <div class="environment-template-copy">
            <strong>{{ template.name }}</strong>
            <code v-if="template.imageId">{{ template.imageId }}</code>
            <span>{{ t("settings.environmentTemplateRegistry.source", { instance: sourceInstanceName(template.sourceInstanceId), date: formatDate(template.createdAt) }) }}</span>
            <span v-if="template.error" class="environment-template-diagnostic">{{ template.error.code }} · {{ template.error.message }}</span>
          </div>
          <div class="environment-template-meta">
            <Badge :variant="template.status === 'ready' ? 'default' : 'secondary'">{{ statusLabel(template.status) }}</Badge>
            <span v-if="template.platform">{{ template.platform }} · {{ template.architecture }}</span>
            <span v-if="template.sizeBytes !== undefined">{{ formatBytes(template.sizeBytes) }}</span>
          </div>
          <Button variant="outline" size="sm" :disabled="deletingId === template.id || template.status === 'creating' || template.status === 'deleting'" @click="deleteTarget = template">
            <Trash2 :size="14" />
            <span>{{ deletingId === template.id ? t("settings.environmentTemplateRegistry.deleting") : t("common.actions.delete") }}</span>
          </Button>
        </article>
        <p v-if="!filteredTemplates.length" class="environment-template-empty">{{ search ? t("settings.environmentTemplateRegistry.noMatches") : t("settings.environmentTemplateRegistry.empty") }}</p>
      </div>
    </div>
  </ScrollArea>

  <Dialog :open="Boolean(deleteTarget)" @update:open="(open) => { if (!open && !deletingId) deleteTarget = undefined }">
    <DialogContent class="environment-template-delete-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("settings.environmentTemplateRegistry.deleteTitle", { name: deleteTarget?.name || '' }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.environmentTemplateRegistry.deleteDescription") }}</DialogDescription>
      </DialogHeader>
      <p v-if="deleteError" class="environment-template-diagnostic" role="alert">{{ deleteError }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(deletingId)" @click="deleteTarget = undefined">{{ t("common.actions.cancel") }}</Button>
        <Button variant="destructive" :disabled="Boolean(deletingId)" @click="removeTemplate">
          <LoaderCircle v-if="deletingId" class="spin" :size="14" /><Trash2 v-else :size="14" />
          {{ deletingId ? t("settings.environmentTemplateRegistry.deleting") : t("common.actions.delete") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { AlertTriangle, LoaderCircle, Package, RefreshCw, Search, Trash2 } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { controlPlaneQueryKeys } from "../../../api/queryKeys";
import { deleteEnvironmentTemplate, useEnvironmentTemplatesQuery } from "../../../api/queries";
import type { EnvironmentTemplate, Node } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const props = defineProps<{ nodes: Node[] }>();
const { locale, t } = useI18n();
const queryClient = useQueryClient();
const nodeId = ref("");
const search = ref("");
const deleteTarget = ref<EnvironmentTemplate>();
const deletingId = ref("");
const deleteError = ref("");
const templates = useEnvironmentTemplatesQuery(nodeId);

watch(() => props.nodes, (nodes) => {
  if (nodeId.value && !nodes.some((node) => node.id === nodeId.value)) nodeId.value = "";
  nodeId.value ||= nodes[0]?.id || "";
}, { immediate: true });

const filteredTemplates = computed(() => {
  const value = search.value.trim().toLocaleLowerCase();
  return (templates.data.value || []).filter((template) => !value || `${template.name} ${template.imageId || ""} ${template.sourceInstanceId} ${template.status}`.toLocaleLowerCase().includes(value));
});

const statusLabel = (status: EnvironmentTemplate["status"]) => t(`settings.environmentTemplateRegistry.status.${status}`);
const sourceInstanceName = (instanceId: string) => instanceId;
const formatDate = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : bytes < 1024 * 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;

async function removeTemplate() {
  const target = deleteTarget.value;
  if (!target || deletingId.value) return;
  deletingId.value = target.id;
  deleteError.value = "";
  try {
    await deleteEnvironmentTemplate(target.nodeId, target.id);
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.environmentTemplates(target.nodeId) });
    deleteTarget.value = undefined;
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingId.value = "";
  }
}
</script>

<style scoped>
.settings-section-scroll { min-height: 0; height: 100%; }
.environment-template-settings { display: grid; gap: 14px; padding: 18px; }
.environment-template-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.environment-template-head > div { display: grid; gap: 4px; }
.environment-template-head strong { font-size: 16px; }
.environment-template-head span, .environment-template-copy span, .environment-template-meta span, .environment-template-empty, .environment-template-error { color: var(--text-muted); font-size: 12px; }
.environment-template-head :deep(.control-plane-select) { min-width: 220px; }
.environment-template-search { display: flex; min-height: 36px; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-raised); padding: 0 10px; color: var(--text-muted); }
.environment-template-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 12px; }
.environment-template-list { display: grid; gap: 7px; }
.environment-template-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto auto; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-raised); padding: 11px 12px; }
.environment-template-row > svg { color: var(--text-muted); }
.environment-template-copy, .environment-template-meta { display: grid; min-width: 0; gap: 3px; }
.environment-template-copy strong { font-size: 13px; }
.environment-template-copy code { overflow: hidden; color: var(--text-subtle); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.environment-template-meta { justify-items: end; }
.environment-template-diagnostic { color: hsl(var(--destructive)) !important; font-size: 12px; overflow-wrap: anywhere; }
.environment-template-empty { padding: 30px 12px; text-align: center; }
.environment-template-error { display: flex; align-items: center; gap: 9px; border: 1px solid hsl(var(--destructive) / .25); border-radius: 8px; padding: 12px; }
.environment-template-error span { flex: 1; }
.environment-template-delete-dialog { max-width: 480px; }
.spin { animation: environment-template-settings-spin 1s linear infinite; }
@keyframes environment-template-settings-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) { .environment-template-head { align-items: stretch; flex-direction: column; } .environment-template-row { grid-template-columns: 24px minmax(0, 1fr) auto; } .environment-template-meta { grid-column: 2 / -1; justify-items: start; } }
</style>
