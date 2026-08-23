<template>
  <ScrollArea class="project-settings-scroll" :horizontal="false">
    <div class="project-settings-page">
      <header class="project-page-head">
        <p>{{ t("settings.projectRegistry.pageDescription") }}</p>
        <Button size="sm" @click="openCreateDialog"><Plus :size="15" /><span>{{ t("settings.projectRegistry.addTitle") }}</span></Button>
      </header>

      <div class="project-toolbar">
        <div class="project-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="searchQuery" type="search" :aria-label="t('settings.projectRegistry.search')" :placeholder="t('settings.projectRegistry.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="sourceFilter" :aria-label="t('settings.projectRegistry.sourceFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.projectRegistry.allSources") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="git-repository">{{ t("settings.projectRegistry.gitRepository") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="local-folder">{{ t("settings.projectRegistry.localFolder") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="usageFilter" :aria-label="t('settings.projectRegistry.usageFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.projectRegistry.allUsage") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="in-use">{{ t("settings.projectRegistry.inUse") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="unused">{{ t("settings.projectRegistry.unused") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section class="project-directory" :aria-label="t('settings.projectRegistry.count', { count: filteredProjects.length })">
        <header class="project-directory-head">
          <strong>{{ t("settings.projectRegistry.count", { count: filteredProjects.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.projectRegistry.filteredFrom", { count: projects.data.value?.length || 0 }) }}</span>
        </header>

        <div v-if="projects.isLoading.value" class="project-state" role="status">{{ t("settings.projectRegistry.loading") }}</div>
        <div v-else-if="projects.error.value" class="project-state project-state-error">
          <span>{{ translateError(projects.error.value) }}</span>
          <Button variant="outline" size="sm" @click="projects.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredProjects.length" class="project-state project-empty-state">
          <FolderGit2 :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.projectRegistry.noMatches") : t("settings.projectRegistry.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.projectRegistry.noMatchesDescription") : t("settings.projectRegistry.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.projectRegistry.clearFilters") }}</Button>
          <Button v-else size="sm" @click="openCreateDialog"><Plus :size="14" />{{ t("settings.projectRegistry.addTitle") }}</Button>
        </div>
        <div v-else class="project-list">
          <article v-for="project in filteredProjects" :key="project.id" class="project-row" data-project-row>
            <div class="project-row-main">
              <div class="project-identity">
                <div class="project-title-line">
                  <strong>{{ project.name }}</strong>
                  <Badge variant="secondary">{{ sourceTypeLabel(project) }}</Badge>
                </div>
                <code :title="projectSourceLabel(project)">{{ projectSourceLabel(project) }}</code>
                <span>{{ project.workspacePolicy.mode }}</span>
              </div>

              <div class="project-summary">
                <Popover>
                  <PopoverTrigger as-child>
                    <button type="button" class="project-summary-item project-summary-trigger">
                      <Link2 :size="14" aria-hidden="true" />
                      <span>{{ t("settings.projectRegistry.references", { count: projectReferences(project.id).length }) }}</span>
                      <ChevronDown :size="14" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent class="project-summary-popover w-[min(288px,var(--reka-popover-content-available-width))] overflow-hidden p-0" align="start" :collision-padding="10" :side-offset="4">
                    <header class="project-summary-popover-head"><strong>{{ t("settings.projectRegistry.usedBy") }}</strong><span>{{ t("settings.projectRegistry.references", { count: projectReferences(project.id).length }) }}</span></header>
                    <ScrollArea v-if="projectReferences(project.id).length" class="project-summary-popover-scroll" :horizontal="false">
                      <div class="project-summary-popover-list">
                        <div v-for="instance in projectReferences(project.id)" :key="instance.id" class="project-summary-popover-row">
                          <Box :size="14" aria-hidden="true" />
                          <span><strong>{{ instance.name }}</strong><small>{{ instance.node?.name || instance.nodeId }}</small></span>
                        </div>
                      </div>
                    </ScrollArea>
                    <p v-else class="project-summary-popover-empty">{{ t("settings.projectRegistry.noReferences") }}</p>
                  </PopoverContent>
                </Popover>
                <span class="project-summary-item"><Image :size="14" aria-hidden="true" />{{ defaultImageLabel(project) }}</span>
                <span v-if="canManageSecrets && project.source.type === 'git-repository'" class="project-summary-item"><KeyRound :size="14" aria-hidden="true" />{{ projectCredentialLabel(project) }}</span>
              </div>

              <div class="project-row-actions">
                <ControlPlaneSelect
                  v-if="canManageSecrets && project.source.type === 'git-repository'"
                  :model-value="project.source.auth?.secretId || NO_GIT_CREDENTIAL_VALUE"
                  :disabled="updatingProjectCredentialId === project.id"
                  :aria-label="t('settings.projectRegistry.credentialFor', { name: project.name })"
                  :placeholder="t('settings.projectRegistry.noCredential')"
                  @update:model-value="updateProjectCredential(project, $event)"
                >
                  <ControlPlaneSelectItem :value="NO_GIT_CREDENTIAL_VALUE">{{ t("settings.projectRegistry.noCredential") }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="credential in managedGitCredentials.data.value || []" :key="credential.id" :value="credential.id" :disabled="credential.status !== 'enabled'">{{ credential.name }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :aria-label="t('settings.projectRegistry.moreActions')"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" :side-offset="6">
                    <DropdownMenuItem :disabled="projectReferences(project.id).length > 0 || deletingProjectId === project.id" @select="requestDelete(project)"><Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span></DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="editorOpen" @update:open="handleEditorOpenChange">
    <DialogContent class="project-editor-dialog w-[min(620px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="project-editor-head space-y-0">
        <div><DialogTitle>{{ t("settings.projectRegistry.addTitle") }}</DialogTitle><DialogDescription>{{ t("settings.projectRegistry.addDescription") }}</DialogDescription></div>
        <Button variant="ghost" size="icon" :aria-label="t('common.actions.close')" @click="requestCloseEditor"><X :size="16" /></Button>
      </DialogHeader>
      <form class="project-editor-form" @submit.prevent="submitProject">
        <section class="project-form-section">
          <header><h3>{{ t("settings.projectRegistry.repositoryInformation") }}</h3><p>{{ t("settings.projectRegistry.repositoryInformationDescription") }}</p></header>
          <label><span>{{ t("settings.fields.name") }}</span><ControlPlaneInput v-model="settingsProject.name" :placeholder="t('settings.projectRegistry.namePlaceholder')" /></label>
          <label>
            <span>{{ t("settings.projectRegistry.gitUrl") }}</span>
            <!-- i18n-audit-allow-next-line code-token: example Git remote URL -->
            <ControlPlaneInput v-model="settingsProject.url" placeholder="https://github.com/org/repo" />
          </label>
        </section>
        <section class="project-form-section">
          <header><h3>{{ t("settings.projectRegistry.defaults") }}</h3><p>{{ t("settings.projectRegistry.defaultsDescription") }}</p></header>
          <label v-if="canManageSecrets"><span>{{ t("settings.projectRegistry.credential") }}</span><ControlPlaneSelect v-model="settingsGitCredentialValue" :placeholder="t('settings.projectRegistry.noCredential')"><ControlPlaneSelectItem :value="NO_GIT_CREDENTIAL_VALUE">{{ t("settings.projectRegistry.noCredential") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-for="credential in enabledManagedGitCredentials" :key="credential.id" :value="credential.id">{{ credential.name }} · {{ credential.scope.host }}{{ credential.scope.pathPrefix }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
          <label><span>{{ t("settings.projectRegistry.defaultImage") }}</span><ControlPlaneSelect v-model="settingsDefaultImageSelectValue" :placeholder="t('settings.projectRegistry.useDefault')"><ControlPlaneSelectItem :value="DEFAULT_SELECT_VALUE">{{ t("settings.projectRegistry.useDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-for="imageOption in imageOptions.data.value || []" :key="imageOption.id" :value="imageOption.id">{{ imageOption.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
        </section>
        <DialogFooter class="project-editor-footer"><Button type="button" variant="outline" :disabled="creatingSettingsProject" @click="requestCloseEditor">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="!canCreateSettingsProject || creatingSettingsProject">{{ creatingSettingsProject ? t("settings.projectRegistry.creating") : t("settings.projectRegistry.create") }}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="closeConfirmationOpen" @update:open="closeConfirmationOpen = $event">
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ t("settings.projectRegistry.discardTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.projectRegistry.discardDescription") }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("settings.projectRegistry.continueEditing") }}</AlertDialogCancel><AlertDialogAction @click="discardAndClose">{{ t("settings.projectRegistry.discard") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="Boolean(deleteTarget)" @update:open="(open) => { if (!open) deleteTarget = undefined; }">
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ t("settings.projectRegistry.deleteTitle", { name: deleteTarget?.name || '' }) }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.projectRegistry.deleteDescription") }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction :disabled="Boolean(deletingProjectId)" @click="confirmDelete">{{ deletingProjectId ? t("settings.projectRegistry.deleting") : t("common.actions.delete") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Box, ChevronDown, FolderGit2, Image, KeyRound, Link2, MoreHorizontal, Plus, Search, Trash2, X } from "@lucide/vue";
import type { Project } from "../../../api/types";
import { useGitCredentialsQuery, useImageOptionsQuery, useInstanceBoardPayloadQuery, useProjectsQuery } from "../../../api/queries";
import { invalidateControlPlaneDomains } from "../../../api/queryInvalidation";
import { translateApiError } from "../../../i18n/apiError";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { DEFAULT_SELECT_VALUE, NO_GIT_CREDENTIAL_VALUE, useProjectSettings } from "./useProjectSettings";

const props = defineProps<{ canManageSecrets: boolean }>();
const { t } = useI18n();
const queryClient = useQueryClient();
const projects = useProjectsQuery();
const managedGitCredentials = useGitCredentialsQuery(computed(() => props.canManageSecrets));
const imageOptions = useImageOptionsQuery();
const board = useInstanceBoardPayloadQuery();
const searchQuery = ref("");
const sourceFilter = ref<"all" | Project["source"]["type"]>("all");
const usageFilter = ref<"all" | "in-use" | "unused">("all");
const editorOpen = ref(false);
const closeConfirmationOpen = ref(false);
const deleteTarget = ref<Project>();
const enabledManagedGitCredentials = computed(() => (managedGitCredentials.data.value || []).filter((credential) => credential.status === "enabled"));
const refreshProjects = () => invalidateControlPlaneDomains(queryClient, ["projects"]);
const translateError = (error: unknown) => translateApiError(error, t, error instanceof Error ? error.message : String(error));
const projectIdsInUse = computed(() => new Set((board.data.value?.data || []).map((instance) => instance.projectId).filter(Boolean)));
const { canCreateSettingsProject, createSettingsProject, creatingSettingsProject, deletingProjectId, projectCredentialLabel, projectSourceLabel, removeProject, resetProjectForm, settingsDefaultImageSelectValue, settingsGitCredentialValue, settingsProject, updateProjectCredential, updatingProjectCredentialId } = useProjectSettings({ errorText: translateError, gitCredentials: computed(() => managedGitCredentials.data.value || []), onProjectDeleted() {}, projectInUse: (projectId) => projectIdsInUse.value.has(projectId), refreshProjects, translate: t });
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim() || sourceFilter.value !== "all" || usageFilter.value !== "all"));
const projectDraftDirty = computed(() => Boolean(settingsProject.name || settingsProject.url || settingsProject.gitCredentialId !== NO_GIT_CREDENTIAL_VALUE || settingsProject.defaultImageSelection));
const filteredProjects = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  return (projects.data.value || []).filter((project) => {
    const used = projectIdsInUse.value.has(project.id);
    return (!query || `${project.name} ${projectSourceLabel(project)}`.toLocaleLowerCase().includes(query))
      && (sourceFilter.value === "all" || project.source.type === sourceFilter.value)
      && (usageFilter.value === "all" || (usageFilter.value === "in-use" ? used : !used));
  });
});

function projectReferences(projectId: string) { return (board.data.value?.data || []).filter((instance) => instance.projectId === projectId); }
function sourceTypeLabel(project: Project) { return project.source.type === "local-folder" ? t("settings.projectRegistry.localFolder") : t("settings.projectRegistry.gitRepository"); }
function defaultImageLabel(project: Project) { const id = project.defaultImageSelection?.imageId; return id ? (imageOptions.data.value || []).find((image) => image.id === id)?.name || id : t("settings.projectRegistry.useDefault"); }
function clearFilters() { searchQuery.value = ""; sourceFilter.value = "all"; usageFilter.value = "all"; }
function openCreateDialog() { resetProjectForm(); editorOpen.value = true; }
function requestCloseEditor() { if (creatingSettingsProject.value) return; if (projectDraftDirty.value) closeConfirmationOpen.value = true; else { editorOpen.value = false; resetProjectForm(); } }
function handleEditorOpenChange(open: boolean) { if (open) editorOpen.value = true; else requestCloseEditor(); }
function discardAndClose() { closeConfirmationOpen.value = false; editorOpen.value = false; resetProjectForm(); }
async function submitProject() { if (await createSettingsProject()) editorOpen.value = false; }
function requestDelete(project: Project) { if (!projectReferences(project.id).length) deleteTarget.value = project; }
async function confirmDelete() { if (!deleteTarget.value) return; if (await removeProject(deleteTarget.value)) deleteTarget.value = undefined; }
</script>

<style scoped>
.project-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.project-settings-page { display: grid; gap: 12px; padding: 0 10px 20px 0; width: 100%; }
.project-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.project-page-head p, .project-form-section h3, .project-form-section p { margin: 0; }
.project-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.project-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px, 1fr) 180px 160px; }
.project-search { align-items: center; display: flex; min-width: 0; position: relative; }
.project-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.project-search :deep(input) { padding-left: 32px; }
.project-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.project-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.project-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.project-directory-head span { color: var(--text-muted); font-size: 12px; }
.project-list { display: grid; }
.project-row + .project-row { border-top: 1px solid var(--line); }
.project-row-main { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(240px, 1.35fr) minmax(220px, 1fr) minmax(190px, auto); min-height: 86px; padding: 11px 12px; }
.project-identity { display: grid; gap: 3px; min-width: 0; }
.project-title-line { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.project-title-line strong { color: var(--text-strong); font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-identity code, .project-identity > span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-summary { align-content: center; display: grid; gap: 5px; min-width: 0; }
.project-summary-item { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; gap: 6px; min-width: 0; }
.project-summary-item svg { flex: 0 0 auto; }
.project-summary-trigger { background: transparent; border: 0; cursor: pointer; padding: 0; text-align: left; width: fit-content; }
.project-summary-trigger:hover, .project-summary-trigger[data-state="open"] { color: var(--text-strong); }
.project-summary-trigger > svg:last-child { transition: transform 140ms ease; }
.project-summary-trigger[data-state="open"] > svg:last-child { transform: rotate(180deg); }
.project-row-actions { align-items: center; display: flex; gap: 4px; justify-content: flex-end; min-width: 0; }
.project-row-actions > :deep(button[role="combobox"]) { max-width: 190px; min-width: 150px; }
.project-summary-popover-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; justify-content: space-between; padding: 7px 9px; }
.project-summary-popover-head strong { color: var(--text-strong); font-size: 12px; font-weight: 500; }
.project-summary-popover-head span { color: var(--text-muted); font-size: 12px; }
.project-summary-popover-scroll { max-height: min(240px, calc(var(--reka-popover-content-available-height) - 34px)); min-height: 0; }
.project-summary-popover-list { display: grid; padding: 2px; }
.project-summary-popover-row { align-items: flex-start; border-radius: 5px; display: grid; gap: 7px; grid-template-columns: auto minmax(0, 1fr); padding: 5px 7px; }
.project-summary-popover-row:hover { background: var(--surface-hover); }
.project-summary-popover-row > svg { color: var(--text-muted); margin-top: 2px; }
.project-summary-popover-row > span { display: grid; gap: 2px; min-width: 0; }
.project-summary-popover-row strong, .project-summary-popover-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-summary-popover-row strong { color: var(--text-strong); font-size: 12px; font-weight: 500; }
.project-summary-popover-row small { color: var(--text-muted); font-size: 12px; }
.project-summary-popover-empty { color: var(--text-muted); font-size: 12px; margin: 0; padding: 10px 9px; }
.project-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; justify-content: center; min-height: 160px; padding: 20px; }
.project-state-error { gap: 10px; }
.project-empty-state { display: grid; gap: 7px; justify-items: center; text-align: center; }
.project-empty-state strong { color: var(--text-strong); font-size: 13px; }
.project-empty-state p { margin: 0; }
.project-editor-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-direction: row; justify-content: space-between; padding: 13px 16px; }
.project-editor-head > div { display: grid; gap: 4px; }
.project-editor-form { display: grid; gap: 16px; }
.project-form-section { display: grid; gap: 10px; padding: 14px 16px 0; }
.project-form-section + .project-form-section { border-top: 1px solid var(--line); padding-top: 16px; }
.project-form-section > header { display: grid; gap: 2px; }
.project-form-section h3 { color: var(--text-strong); font-size: 13px; font-weight: 600; }
.project-form-section header p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.project-form-section label { display: grid; gap: 5px; }
.project-form-section label > span { color: var(--text-muted); font-size: 12px; }
.project-editor-footer { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; margin-top: 2px; padding: 8px 16px; }
@media (max-width: 900px) { .project-row-main { grid-template-columns: minmax(0, 1fr) auto; } .project-summary { grid-column: 1; } .project-row-actions { grid-column: 2; grid-row: 1 / span 2; } }
@media (max-width: 720px) { .project-toolbar { grid-template-columns: 1fr; } .project-row-main { grid-template-columns: 1fr; } .project-summary, .project-row-actions { grid-column: 1; grid-row: auto; } .project-row-actions { justify-content: flex-start; } }
</style>
