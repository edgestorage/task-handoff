<template>
  <ScrollArea class="environment-template-scroll" :horizontal="false">
    <div class="environment-template-page">
      <header class="environment-template-page-head">
        <p>{{ t("settings.environmentTemplateRegistry.description") }}</p>
      </header>

      <div class="environment-template-toolbar">
        <div class="environment-template-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="search" :aria-label="t('settings.environmentTemplateRegistry.searchLabel')" :placeholder="t('settings.environmentTemplateRegistry.search')" />
        </div>
        <ControlPlaneSelect v-model="nodeId" :placeholder="t('settings.environmentTemplateRegistry.selectNode')">
          <ControlPlaneSelectItem v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="statusFilter" :aria-label="t('settings.environmentTemplateRegistry.statusFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.environmentTemplateRegistry.allStatuses") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="ready">{{ statusLabel("ready") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="creating">{{ statusLabel("creating") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="failed">{{ statusLabel("failed") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="deleting">{{ statusLabel("deleting") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section class="environment-template-directory" :aria-label="t('settings.environmentTemplateRegistry.count', { count: filteredTemplates.length })">
        <header class="environment-template-directory-head">
          <strong>{{ t("settings.environmentTemplateRegistry.count", { count: filteredTemplates.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.environmentTemplateRegistry.filteredFrom", { count: templates.data.value?.length || 0 }) }}</span>
        </header>

        <div v-if="templates.isLoading.value" class="environment-template-state" role="status">{{ t("settings.environmentTemplateRegistry.loading") }}</div>
        <div v-else-if="templates.error.value" class="environment-template-state environment-template-state-error" role="alert">
          <AlertTriangle :size="16" /><span>{{ t("settings.environmentTemplateRegistry.nodeUnavailable") }}</span>
          <Button variant="outline" size="sm" @click="templates.refetch()"><RefreshCw :size="14" />{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredTemplates.length" class="environment-template-state environment-template-empty-state">
          <Package :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.environmentTemplateRegistry.noMatches") : t("settings.environmentTemplateRegistry.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.environmentTemplateRegistry.noMatchesDescription") : t("settings.environmentTemplateRegistry.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.environmentTemplateRegistry.clearFilters") }}</Button>
        </div>
        <div v-else class="environment-template-list">
          <article v-for="template in filteredTemplates" :key="template.id" class="environment-template-row" data-environment-template-row>
            <div class="environment-template-identity">
              <span class="environment-template-icon"><Package :size="16" /></span>
              <div class="environment-template-copy">
                <div class="environment-template-title-line"><strong>{{ template.name }}</strong><Badge :variant="template.status === 'ready' ? 'default' : 'secondary'">{{ statusLabel(template.status) }}</Badge></div>
                <code v-if="template.imageId" :title="template.imageId">{{ template.imageId }}</code>
                <span>{{ t("settings.environmentTemplateRegistry.source", { instance: sourceInstanceName(template.sourceInstanceId), date: formatDate(template.createdAt) }) }}</span>
                <span v-if="template.error" class="environment-template-diagnostic">{{ template.error.code }} · {{ template.error.message }}</span>
              </div>
            </div>
            <div class="environment-template-summary">
              <span v-if="template.platform"><Monitor :size="14" />{{ template.platform }} · {{ template.architecture }}</span>
              <span v-if="template.sizeBytes !== undefined"><HardDrive :size="14" />{{ formatBytes(template.sizeBytes) }}</span>
            </div>
            <div class="environment-template-actions">
              <DropdownMenu>
                <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :aria-label="t('settings.environmentTemplateRegistry.moreActions')" :disabled="deletingId === template.id || template.status === 'creating' || template.status === 'deleting'"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" :side-offset="6">
                  <DropdownMenuItem class="text-destructive focus:text-destructive" @select="requestDelete(template)"><Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <AlertDialog :open="Boolean(deleteTarget)" @update:open="(open) => { if (!open && !deletingId) deleteTarget = undefined }">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.environmentTemplateRegistry.deleteTitle", { name: deleteTarget?.name || '' }) }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.environmentTemplateRegistry.deleteDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <p v-if="deleteError" class="environment-template-diagnostic" role="alert">{{ deleteError }}</p>
      <AlertDialogFooter><AlertDialogCancel :disabled="Boolean(deletingId)">{{ t("common.actions.cancel") }}</AlertDialogCancel><Button variant="destructive" :disabled="Boolean(deletingId)" @click="removeTemplate"><LoaderCircle v-if="deletingId" class="spin" :size="14" /><Trash2 v-else :size="14" />{{ deletingId ? t("settings.environmentTemplateRegistry.deleting") : t("common.actions.delete") }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { AlertTriangle, HardDrive, LoaderCircle, Monitor, MoreHorizontal, Package, RefreshCw, Search, Trash2 } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { controlPlaneQueryKeys } from "../../../api/queryKeys";
import { deleteEnvironmentTemplate, useEnvironmentTemplatesQuery } from "../../../api/queries";
import type { EnvironmentTemplate, Node } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const props = defineProps<{ nodes: Node[] }>();
const { locale, t } = useI18n();
const queryClient = useQueryClient();
const nodeId = ref("");
const search = ref("");
const statusFilter = ref<"all" | EnvironmentTemplate["status"]>("all");
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
  return (templates.data.value || []).filter((template) => (!value || `${template.name} ${template.imageId || ""} ${template.sourceInstanceId} ${template.status}`.toLocaleLowerCase().includes(value)) && (statusFilter.value === "all" || template.status === statusFilter.value));
});
const hasActiveFilters = computed(() => Boolean(search.value.trim()) || statusFilter.value !== "all");

const statusLabel = (status: EnvironmentTemplate["status"]) => t(`settings.environmentTemplateRegistry.status.${status}`);
const sourceInstanceName = (instanceId: string) => instanceId;
const formatDate = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : bytes < 1024 * 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
function clearFilters() { search.value = ""; statusFilter.value = "all"; }
function requestDelete(template: EnvironmentTemplate) { deleteError.value = ""; deleteTarget.value = template; }

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
.environment-template-scroll { height: 100%; min-height: 0; width: 100%; }
.environment-template-page { display: grid; gap: 12px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, var(--settings-content-max-width, 1080px)); }
.environment-template-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; margin: 0; }
.environment-template-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px, 1fr) 220px 170px; }
.environment-template-search { align-items: center; display: flex; min-width: 0; position: relative; }
.environment-template-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.environment-template-search :deep(input) { padding-left: 32px; }
.environment-template-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.environment-template-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.environment-template-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.environment-template-directory-head span { color: var(--text-muted); font-size: 12px; }
.environment-template-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; justify-content: center; min-height: 160px; padding: 20px; }
.environment-template-state-error { gap: 10px; }
.environment-template-state-error span { flex: 1; }
.environment-template-empty-state { align-content: center; display: grid; gap: 7px; justify-items: center; min-height: 220px; text-align: center; }
.environment-template-empty-state strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.environment-template-empty-state p { margin: 0 0 5px; }
.environment-template-list { display: grid; }
.environment-template-row + .environment-template-row { border-top: 1px solid var(--line); }
.environment-template-row { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(280px, 1.25fr) minmax(200px, .75fr) auto; min-height: 82px; padding: 10px 12px; }
.environment-template-identity { align-items: flex-start; display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr); min-width: 0; }
.environment-template-icon { align-items: center; background: var(--surface-active); border: 1px solid var(--line-subtle); border-radius: 7px; color: var(--text-muted); display: flex; height: 32px; justify-content: center; width: 32px; }
.environment-template-copy, .environment-template-summary { display: grid; min-width: 0; gap: 3px; }
.environment-template-title-line { align-items: center; display: flex; gap: 7px; min-width: 0; }
.environment-template-title-line strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-template-copy code, .environment-template-copy > span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-template-summary { gap: 6px; }
.environment-template-summary span { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; gap: 6px; }
.environment-template-actions { display: flex; justify-content: flex-end; }
.environment-template-diagnostic { color: hsl(var(--destructive)) !important; font-size: 12px; overflow-wrap: anywhere; }
.spin { animation: environment-template-settings-spin 1s linear infinite; }
@keyframes environment-template-settings-spin { to { transform: rotate(360deg); } }
@media(max-width: 800px) { .environment-template-page { padding-right: 7px; } .environment-template-toolbar { grid-template-columns: 1fr 1fr; } .environment-template-search { grid-column: 1 / -1; } .environment-template-row { align-items: start; grid-template-columns: 1fr auto; } .environment-template-summary { grid-column: 1 / -1; } }
</style>
