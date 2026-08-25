<template>
  <ScrollArea class="git-credentials-scroll" :horizontal="false">
    <div class="git-credentials-page">
      <header class="git-credentials-page-head">
        <p>{{ t("settings.gitCredentials.description") }}</p>
        <Button size="sm" @click="openCreate">
          <Plus :size="14" />
          <span>{{ t("settings.gitCredentials.add") }}</span>
        </Button>
      </header>

      <div class="git-credentials-toolbar">
        <div class="git-credentials-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="searchQuery" :aria-label="t('settings.gitCredentials.search')" :placeholder="t('settings.gitCredentials.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="kindFilter" :aria-label="t('settings.gitCredentials.kindFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.gitCredentials.allKinds") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="https-token">HTTPS</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="ssh-key">SSH</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="statusFilter" :aria-label="t('settings.gitCredentials.statusFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.gitCredentials.allStatuses") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="enabled">{{ t("settings.gitCredentials.status.enabled") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="disabled">{{ t("settings.gitCredentials.status.disabled") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section class="git-credentials-directory" :aria-label="t('settings.gitCredentials.count', { count: filteredCredentials.length })">
        <header class="git-credentials-directory-head">
          <strong>{{ t("settings.gitCredentials.count", { count: filteredCredentials.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.gitCredentials.filteredFrom", { count: credentials.data.value?.length || 0 }) }}</span>
        </header>

        <div v-if="credentials.isLoading.value" class="git-credentials-state" role="status">{{ t("settings.gitCredentials.loading") }}</div>
        <div v-else-if="credentials.error.value" class="git-credentials-state git-credentials-state-error" role="alert">
          <span>{{ errorText(credentials.error.value, "loadFailed") }}</span>
          <Button variant="outline" size="sm" @click="credentials.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredCredentials.length" class="git-credentials-state git-credentials-empty-state">
          <KeyRound :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.gitCredentials.noMatches") : t("settings.gitCredentials.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.gitCredentials.noMatchesDescription") : t("settings.gitCredentials.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.gitCredentials.clearFilters") }}</Button>
          <Button v-else size="sm" @click="openCreate"><Plus :size="14" />{{ t("settings.gitCredentials.add") }}</Button>
        </div>
        <div v-else class="git-credential-list">
          <article v-for="credential in filteredCredentials" :key="credential.id" class="git-credential-row" data-git-credential-row>
            <div class="git-credential-identity">
              <span class="git-credential-kind" aria-hidden="true">
                <KeyRound v-if="credential.kind === 'ssh-key'" :size="16" />
                <LockKeyhole v-else :size="16" />
              </span>
              <div class="git-credential-copy">
                <div class="git-credential-title">
                  <strong>{{ credential.name }}</strong>
                  <Badge variant="secondary">{{ credential.kind === "ssh-key" ? "SSH" : "HTTPS" }}</Badge>
                  <Badge :variant="credential.status === 'enabled' ? 'default' : 'secondary'">{{ t(`settings.gitCredentials.status.${credential.status}`) }}</Badge>
                </div>
                <code :title="scopeLabel(credential)">{{ scopeLabel(credential) }}</code>
                <small>{{ t("settings.gitCredentials.revision", { revision: credential.revision }) }}</small>
              </div>
            </div>
            <div class="git-credential-actions">
              <Button variant="outline" size="sm" :disabled="busyId === credential.id" @click="openEdit(credential)">
                <Settings :size="14" />
                <span>{{ t("settings.gitCredentials.configure") }}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon" :aria-label="t('settings.gitCredentials.moreActions')" :disabled="busyId === credential.id"><MoreHorizontal :size="16" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" :side-offset="6">
                  <DropdownMenuItem @select="toggleStatus(credential)">
                    <Power :size="14" />
                    <span>{{ t(`settings.gitCredentials.${credential.status === 'enabled' ? 'disable' : 'enable'}`) }}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem class="text-destructive focus:text-destructive" @select="pendingDelete = credential">
                    <Trash2 :size="14" />
                    <span>{{ t("settings.gitCredentials.delete") }}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="formOpen" @update:open="handleFormOpenChange">
    <DialogContent class="git-credential-dialog w-[min(680px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="git-credential-dialog-head space-y-0">
        <div>
          <DialogTitle>{{ editing ? t("settings.gitCredentials.editTitle") : t("settings.gitCredentials.createTitle") }}</DialogTitle>
          <DialogDescription>{{ editing ? t("settings.gitCredentials.editDescription") : t("settings.gitCredentials.createDescription") }}</DialogDescription>
        </div>
        <Button variant="ghost" size="icon" :aria-label="t('common.actions.close')" @click="requestCloseForm"><X :size="16" /></Button>
      </DialogHeader>
      <ScrollArea class="git-credential-dialog-scroll" :horizontal="false">
        <form class="git-credential-form" @submit.prevent="save">
          <section class="git-credential-form-section">
            <header><h3>{{ t("settings.gitCredentials.basicInformation") }}</h3><p>{{ t("settings.gitCredentials.basicInformationDescription") }}</p></header>
            <div class="git-credential-form-grid">
              <label><span>{{ t("settings.gitCredentials.name") }}</span><ControlPlaneInput v-model="draft.name" autocomplete="off" /></label>
              <label><span>{{ t("settings.gitCredentials.kind") }}</span><ControlPlaneSelect v-model="draft.kind" :disabled="Boolean(editing)"><ControlPlaneSelectItem value="https-token">HTTPS token</ControlPlaneSelectItem><ControlPlaneSelectItem value="ssh-key">SSH key</ControlPlaneSelectItem></ControlPlaneSelect></label>
            </div>
          </section>

          <section class="git-credential-form-section">
            <header><h3>{{ t("settings.gitCredentials.scope") }}</h3><p>{{ t("settings.gitCredentials.scopeDescription") }}</p></header>
            <div class="git-scope-fields">
              <label>
                <span>{{ t("settings.gitCredentials.host") }}</span>
                <!-- i18n-audit-allow-next-line code-token: example Git host -->
                <ControlPlaneInput v-model="draft.host" autocomplete="off" placeholder="git.example.com" />
              </label>
              <label><span>{{ t("settings.gitCredentials.port") }}</span><ControlPlaneInput v-model="draft.port" inputmode="numeric" autocomplete="off" :placeholder="draft.kind === 'ssh-key' ? '22' : '443'" /></label>
            </div>
            <label>
              <span>{{ t("settings.gitCredentials.pathPrefix") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example repository path scope -->
              <ControlPlaneInput v-model="draft.pathPrefix" autocomplete="off" placeholder="/organization/" />
            </label>
          </section>

          <section class="git-credential-form-section">
            <header><h3>{{ t("settings.gitCredentials.authentication") }}</h3><p>{{ t("settings.gitCredentials.authenticationDescription") }}</p></header>
            <template v-if="draft.kind === 'https-token'">
              <label><span>{{ t("settings.gitCredentials.username") }}</span><ControlPlaneInput v-model="draft.username" autocomplete="off" /></label>
              <label><span>{{ t("settings.gitCredentials.token") }}</span><ControlPlaneInput v-model="draft.token" type="password" autocomplete="new-password" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" /></label>
            </template>
            <template v-else>
              <label><span>{{ t("settings.gitCredentials.privateKey") }}</span><Textarea v-model="draft.privateKey" autocomplete="off" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" /></label>
              <label><span>{{ t("settings.gitCredentials.passphrase") }}</span><ControlPlaneInput v-model="draft.passphrase" type="password" autocomplete="new-password" /></label>
              <label><span>{{ t("settings.gitCredentials.knownHosts") }}</span><Textarea v-model="draft.knownHosts" autocomplete="off" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" /></label>
            </template>
          </section>
          <p v-if="formError" class="git-credentials-form-error" role="alert">{{ formError }}</p>
        </form>
      </ScrollArea>
      <DialogFooter class="git-credential-dialog-footer">
        <Button variant="outline" :disabled="saving" @click="requestCloseForm">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="saving || !formReady" @click="save">{{ saving ? t("settings.gitCredentials.saving") : t("common.actions.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="Boolean(pendingDelete)" @update:open="(open) => { if (!open && !busyId) pendingDelete = undefined; }">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.gitCredentials.deleteTitle", { name: pendingDelete?.name || '' }) }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.gitCredentials.deleteDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel :disabled="Boolean(busyId)">{{ t("common.actions.cancel") }}</AlertDialogCancel><Button variant="destructive" :disabled="Boolean(busyId)" @click="removeCredential">{{ t("settings.gitCredentials.delete") }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="closeConfirmationOpen" @update:open="closeConfirmationOpen = $event">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.gitCredentials.discardTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.gitCredentials.discardDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction @click="discardAndClose">{{ t("settings.gitCredentials.discard") }}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { KeyRound, LockKeyhole, MoreHorizontal, Plus, Power, Search, Settings, Trash2, X } from "@lucide/vue";
import type { GitCredentialCreateRequest, GitCredentialPublic, GitCredentialUpdateRequest } from "@task-handoff/protocol/managed-git-credentials";
import { createGitCredential, deleteGitCredential, updateGitCredential, useGitCredentialsQuery } from "../../../api/queries";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ enabled?: boolean }>();
const { t } = useI18n();
const credentials = useGitCredentialsQuery(computed(() => props.enabled !== false));
const formOpen = ref(false);
const closeConfirmationOpen = ref(false);
const editing = ref<GitCredentialPublic>();
const pendingDelete = ref<GitCredentialPublic>();
const saving = ref(false);
const busyId = ref("");
const formError = ref("");
const searchQuery = ref("");
const kindFilter = ref<"all" | GitCredentialPublic["kind"]>("all");
const statusFilter = ref<"all" | GitCredentialPublic["status"]>("all");
const emptyDraft = () => ({ kind: "https-token" as "https-token" | "ssh-key", name: "", host: "", port: "", pathPrefix: "/", username: "", token: "", privateKey: "", passphrase: "", knownHosts: "" });
const draft = reactive(emptyDraft());
const formBaseline = ref(JSON.stringify(emptyDraft()));

const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim()) || kindFilter.value !== "all" || statusFilter.value !== "all");
const filteredCredentials = computed(() => (credentials.data.value || []).filter((credential) => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  const matchesQuery = !query || `${credential.name} ${scopeLabel(credential)} ${credential.kind}`.toLocaleLowerCase().includes(query);
  return matchesQuery && (kindFilter.value === "all" || credential.kind === kindFilter.value) && (statusFilter.value === "all" || credential.status === statusFilter.value);
}));
const formDirty = computed(() => JSON.stringify(draft) !== formBaseline.value);

const formReady = computed(() => {
  if (!draft.name.trim() || !draft.host.trim() || !draft.pathPrefix.trim()) return false;
  if (!editing.value) return Boolean(draft.kind === "https-token" ? draft.username.trim() && draft.token : draft.privateKey && draft.knownHosts);
  if (draft.kind === "https-token") return !draft.token || Boolean(draft.username.trim());
  return (!draft.privateKey && !draft.knownHosts) || Boolean(draft.privateKey && draft.knownHosts);
});
const errorText = (error: unknown, key: string) => translateApiError(error, t, t(`settings.gitCredentials.${key}`));
const scopeLabel = (credential: GitCredentialPublic) => `${credential.scope.scheme}://${credential.scope.host}${credential.scope.port ? `:${credential.scope.port}` : ""}${credential.scope.pathPrefix}`;

function resetDraft() { Object.assign(draft, emptyDraft()); formBaseline.value = JSON.stringify(draft); formError.value = ""; }
function markFormBaseline() { formBaseline.value = JSON.stringify(draft); }
function openCreate() { editing.value = undefined; resetDraft(); markFormBaseline(); formOpen.value = true; }
function openEdit(credential: GitCredentialPublic) {
  editing.value = credential;
  Object.assign(draft, emptyDraft(), {
    kind: credential.kind,
    name: credential.name,
    host: credential.scope.host,
    port: credential.scope.port ? String(credential.scope.port) : "",
    pathPrefix: credential.scope.pathPrefix,
  });
  markFormBaseline();
  formError.value = "";
  formOpen.value = true;
}
function setFormOpen(open: boolean) {
  if (saving.value) return;
  formOpen.value = open;
  if (!open) { editing.value = undefined; resetDraft(); }
}
function handleFormOpenChange(open: boolean) { if (open) formOpen.value = true; else requestCloseForm(); }
function requestCloseForm() { if (saving.value) return; if (formDirty.value) closeConfirmationOpen.value = true; else setFormOpen(false); }
function discardAndClose() { closeConfirmationOpen.value = false; setFormOpen(false); }
function clearFilters() { searchQuery.value = ""; kindFilter.value = "all"; statusFilter.value = "all"; }
function scope() {
  return { scheme: draft.kind === "ssh-key" ? "ssh" as const : "https" as const, host: draft.host.trim(), ...(draft.port.trim() ? { port: Number(draft.port) } : {}), pathPrefix: draft.pathPrefix.trim() };
}
function secret() {
  return draft.kind === "https-token"
    ? { kind: "https-token" as const, username: draft.username.trim(), token: draft.token }
    : { kind: "ssh-key" as const, privateKey: draft.privateKey, ...(draft.passphrase ? { passphrase: draft.passphrase } : {}), pinnedKnownHosts: draft.knownHosts };
}
async function save() {
  if (!formReady.value || saving.value) return;
  saving.value = true;
  formError.value = "";
  try {
    if (editing.value) {
      const input: GitCredentialUpdateRequest = { name: draft.name.trim(), scope: scope(), ...((draft.kind === "https-token" ? draft.token : draft.privateKey || draft.knownHosts) ? { secret: secret() } : {}) };
      await updateGitCredential(editing.value.id, input);
    } else {
      await createGitCredential({ name: draft.name.trim(), scope: scope(), secret: secret() } satisfies GitCredentialCreateRequest);
    }
    formOpen.value = false;
    editing.value = undefined;
    resetDraft();
    await credentials.refetch();
    showControlPlaneToast(t("settings.gitCredentials.saved"), "success");
  } catch (error) {
    formError.value = errorText(error, "saveFailed");
  } finally {
    saving.value = false;
  }
}
async function toggleStatus(credential: GitCredentialPublic) {
  busyId.value = credential.id;
  try {
    await updateGitCredential(credential.id, { status: credential.status === "enabled" ? "disabled" : "enabled" });
    await credentials.refetch();
  } catch (error) { showControlPlaneToast(errorText(error, "saveFailed")); }
  finally { busyId.value = ""; }
}
async function removeCredential() {
  const credential = pendingDelete.value;
  if (!credential) return;
  busyId.value = credential.id;
  try {
    await deleteGitCredential(credential.id);
    pendingDelete.value = undefined;
    await credentials.refetch();
  } catch (error) { showControlPlaneToast(errorText(error, "deleteFailed")); }
  finally { busyId.value = ""; }
}
</script>

<style scoped>
.git-credentials-scroll { height: 100%; min-height: 0; width: 100%; }
.git-credentials-page { display: grid; gap: 12px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, var(--settings-content-max-width, 1080px)); }
.git-credentials-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.git-credentials-page-head p, .git-credential-form-section h3, .git-credential-form-section p { margin: 0; }
.git-credentials-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.git-credentials-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px, 1fr) 180px 160px; }
.git-credentials-search { align-items: center; display: flex; min-width: 0; position: relative; }
.git-credentials-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.git-credentials-search :deep(input) { padding-left: 32px; }
.git-credentials-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.git-credentials-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.git-credentials-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.git-credentials-directory-head span { color: var(--text-muted); font-size: 12px; }
.git-credentials-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; justify-content: center; min-height: 160px; padding: 20px; }
.git-credentials-state-error { gap: 10px; }
.git-credentials-empty-state { display: grid; gap: 7px; justify-items: center; min-height: 220px; text-align: center; }
.git-credentials-empty-state strong { color: var(--text-strong); font-size: 13px; font-weight: 500; margin-top: 3px; }
.git-credentials-empty-state p { margin: 0 0 5px; }
.git-credential-list { display: grid; }
.git-credential-row + .git-credential-row { border-top: 1px solid var(--line); }
.git-credential-row { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) auto; min-height: 76px; padding: 10px 12px; }
.git-credential-identity { align-items: flex-start; display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr); min-width: 0; }
.git-credential-kind { align-items: center; background: var(--surface-active); border: 1px solid var(--line-subtle); border-radius: 7px; color: var(--text-muted); display: flex; height: 32px; justify-content: center; width: 32px; }
.git-credential-copy { display: grid; gap: 3px; min-width: 0; }
.git-credential-title { align-items: center; display: flex; gap: 7px; min-width: 0; }
.git-credential-title strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-credential-copy code, .git-credential-copy small { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-credential-actions { align-items: center; display: flex; gap: 4px; justify-content: flex-end; }
:global(.git-credential-dialog) { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: min(680px, calc(100vh - 40px)); }
.git-credential-dialog-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-direction: row; justify-content: space-between; padding: 13px 16px; }
.git-credential-dialog-head > div { display: grid; gap: 4px; }
.git-credential-dialog-scroll { min-height: 0; }
.git-credential-form { display: grid; gap: 16px; padding: 14px 16px 18px; }
.git-credential-form-section { display: grid; gap: 10px; }
.git-credential-form-section + .git-credential-form-section { border-top: 1px solid var(--line); padding-top: 16px; }
.git-credential-form-section > header { display: grid; gap: 2px; }
.git-credential-form-section h3 { color: var(--text-strong); font-size: 13px; font-weight: 600; }
.git-credential-form-section header p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.git-credential-form-section label { display: grid; gap: 5px; }
.git-credential-form-section label > span { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.git-credential-form-grid { display: grid; gap: 9px; grid-template-columns: 1fr 180px; }
.git-credential-form textarea { min-height: 96px; resize: vertical; }
.git-scope-fields { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 110px; }
.git-credentials-form-error { color: var(--status-danger); font-size: 12px; margin: 0; }
.git-credential-dialog-footer { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px; }
@media (max-width: 760px) {
  .git-credentials-page { padding-right: 7px; }
  .git-credentials-toolbar { grid-template-columns: 1fr 1fr; }
  .git-credentials-search { grid-column: 1 / -1; }
  .git-credential-row { align-items: start; }
  .git-credential-form-grid,
  .git-scope-fields { grid-template-columns: 1fr; }
}
</style>
