<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content git-credentials-settings">
      <section class="modal-section settings-panel-surface git-credentials-panel">
        <header class="git-credentials-head">
          <div>
            <strong>{{ t("settings.gitCredentials.title") }}</strong>
            <p>{{ t("settings.gitCredentials.description") }}</p>
          </div>
          <Button size="sm" @click="openCreate">
            <Plus :size="14" />
            <span>{{ t("settings.gitCredentials.add") }}</span>
          </Button>
        </header>

        <p v-if="credentials.isLoading.value" class="git-credentials-state" role="status">{{ t("settings.gitCredentials.loading") }}</p>
        <div v-else-if="credentials.error.value" class="git-credentials-error" role="alert">
          <span>{{ errorText(credentials.error.value, "loadFailed") }}</span>
          <Button variant="outline" size="sm" @click="credentials.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <p v-else-if="!credentials.data.value?.length" class="git-credentials-state">{{ t("settings.gitCredentials.empty") }}</p>
        <div v-else class="git-credential-list">
          <article v-for="credential in credentials.data.value" :key="credential.id" class="git-credential-row">
            <div class="git-credential-kind" aria-hidden="true">
              <KeyRound v-if="credential.kind === 'ssh-key'" :size="18" />
              <LockKeyhole v-else :size="18" />
            </div>
            <div class="git-credential-copy">
              <div class="git-credential-title">
                <strong>{{ credential.name }}</strong>
                <Badge variant="secondary">{{ credential.kind === "ssh-key" ? "SSH" : "HTTPS" }}</Badge>
                <Badge :variant="credential.status === 'enabled' ? 'default' : 'secondary'">{{ t(`settings.gitCredentials.status.${credential.status}`) }}</Badge>
              </div>
              <code>{{ scopeLabel(credential) }}</code>
              <small>{{ t("settings.gitCredentials.revision", { revision: credential.revision }) }}</small>
            </div>
            <div class="git-credential-actions">
              <Button variant="outline" size="sm" :disabled="busyId === credential.id" @click="openEdit(credential)">
                <RotateCw :size="14" />
                <span>{{ t("settings.gitCredentials.edit") }}</span>
              </Button>
              <Button variant="outline" size="sm" :disabled="busyId === credential.id" @click="toggleStatus(credential)">
                <Power :size="14" />
                <span>{{ t(`settings.gitCredentials.${credential.status === 'enabled' ? 'disable' : 'enable'}`) }}</span>
              </Button>
              <Button variant="ghost" size="icon" :aria-label="t('settings.gitCredentials.delete')" :title="t('settings.gitCredentials.delete')" :disabled="busyId === credential.id" @click="pendingDelete = credential">
                <Trash2 :size="15" />
              </Button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="formOpen" @update:open="setFormOpen">
    <DialogContent class="git-credential-dialog">
      <DialogHeader>
        <DialogTitle>{{ editing ? t("settings.gitCredentials.editTitle") : t("settings.gitCredentials.createTitle") }}</DialogTitle>
        <DialogDescription>{{ editing ? t("settings.gitCredentials.editDescription") : t("settings.gitCredentials.createDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="git-credential-form">
        <label>
          <span>{{ t("settings.gitCredentials.name") }}</span>
          <ControlPlaneInput v-model="draft.name" autocomplete="off" />
        </label>
        <label>
          <span>{{ t("settings.gitCredentials.kind") }}</span>
          <ControlPlaneSelect v-model="draft.kind" :disabled="Boolean(editing)">
            <ControlPlaneSelectItem value="https-token">HTTPS token</ControlPlaneSelectItem>
            <ControlPlaneSelectItem value="ssh-key">SSH key</ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </label>
        <div class="git-scope-fields">
          <label>
            <span>{{ t("settings.gitCredentials.host") }}</span>
            <!-- i18n-audit-allow-next-line code-token: example Git host -->
            <ControlPlaneInput v-model="draft.host" autocomplete="off" placeholder="git.example.com" />
          </label>
          <label>
            <span>{{ t("settings.gitCredentials.port") }}</span>
            <ControlPlaneInput v-model="draft.port" inputmode="numeric" autocomplete="off" :placeholder="draft.kind === 'ssh-key' ? '22' : '443'" />
          </label>
        </div>
        <label>
          <span>{{ t("settings.gitCredentials.pathPrefix") }}</span>
          <!-- i18n-audit-allow-next-line code-token: example repository path scope -->
          <ControlPlaneInput v-model="draft.pathPrefix" autocomplete="off" placeholder="/organization/" />
        </label>
        <template v-if="draft.kind === 'https-token'">
          <label>
            <span>{{ t("settings.gitCredentials.username") }}</span>
            <ControlPlaneInput v-model="draft.username" autocomplete="off" />
          </label>
          <label>
            <span>{{ t("settings.gitCredentials.token") }}</span>
            <ControlPlaneInput v-model="draft.token" type="password" autocomplete="new-password" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" />
          </label>
        </template>
        <template v-else>
          <label>
            <span>{{ t("settings.gitCredentials.privateKey") }}</span>
            <Textarea v-model="draft.privateKey" autocomplete="off" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" />
          </label>
          <label>
            <span>{{ t("settings.gitCredentials.passphrase") }}</span>
            <ControlPlaneInput v-model="draft.passphrase" type="password" autocomplete="new-password" />
          </label>
          <label>
            <span>{{ t("settings.gitCredentials.knownHosts") }}</span>
            <Textarea v-model="draft.knownHosts" autocomplete="off" :placeholder="editing ? t('settings.gitCredentials.keepSecret') : ''" />
          </label>
        </template>
        <p v-if="formError" class="git-credentials-form-error" role="alert">{{ formError }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="setFormOpen(false)">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="saving || !formReady" @click="save">{{ saving ? t("settings.gitCredentials.saving") : t("common.actions.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="Boolean(pendingDelete)" @update:open="(open) => { if (!open && !busyId) pendingDelete = undefined; }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.gitCredentials.deleteTitle", { name: pendingDelete?.name || '' }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.gitCredentials.deleteDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(busyId)" @click="pendingDelete = undefined">{{ t("common.actions.cancel") }}</Button>
        <Button variant="destructive" :disabled="Boolean(busyId)" @click="removeCredential">{{ t("settings.gitCredentials.delete") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { KeyRound, LockKeyhole, Plus, Power, RotateCw, Trash2 } from "@lucide/vue";
import type { GitCredentialCreateRequest, GitCredentialPublic, GitCredentialUpdateRequest } from "@task-handoff/protocol/managed-git-credentials";
import { createGitCredential, deleteGitCredential, updateGitCredential, useGitCredentialsQuery } from "../../../api/queries";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
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
const editing = ref<GitCredentialPublic>();
const pendingDelete = ref<GitCredentialPublic>();
const saving = ref(false);
const busyId = ref("");
const formError = ref("");
const emptyDraft = () => ({ kind: "https-token" as "https-token" | "ssh-key", name: "", host: "", port: "", pathPrefix: "/", username: "", token: "", privateKey: "", passphrase: "", knownHosts: "" });
const draft = reactive(emptyDraft());

const formReady = computed(() => {
  if (!draft.name.trim() || !draft.host.trim() || !draft.pathPrefix.trim()) return false;
  if (!editing.value) return Boolean(draft.kind === "https-token" ? draft.username.trim() && draft.token : draft.privateKey && draft.knownHosts);
  if (draft.kind === "https-token") return !draft.token || Boolean(draft.username.trim());
  return (!draft.privateKey && !draft.knownHosts) || Boolean(draft.privateKey && draft.knownHosts);
});
const errorText = (error: unknown, key: string) => translateApiError(error, t, t(`settings.gitCredentials.${key}`));
const scopeLabel = (credential: GitCredentialPublic) => `${credential.scope.scheme}://${credential.scope.host}${credential.scope.port ? `:${credential.scope.port}` : ""}${credential.scope.pathPrefix}`;

function resetDraft() { Object.assign(draft, emptyDraft()); formError.value = ""; }
function openCreate() { editing.value = undefined; resetDraft(); formOpen.value = true; }
function openEdit(credential: GitCredentialPublic) {
  editing.value = credential;
  Object.assign(draft, emptyDraft(), {
    kind: credential.kind,
    name: credential.name,
    host: credential.scope.host,
    port: credential.scope.port ? String(credential.scope.port) : "",
    pathPrefix: credential.scope.pathPrefix,
  });
  formError.value = "";
  formOpen.value = true;
}
function setFormOpen(open: boolean) {
  if (saving.value) return;
  formOpen.value = open;
  if (!open) { editing.value = undefined; resetDraft(); }
}
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
.git-credentials-settings { max-width: 980px; }
.git-credentials-panel { align-content: start; }
.git-credentials-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.git-credentials-head > div { display: grid; gap: 4px; }
.git-credentials-head strong { color: var(--text-strong); font-size: 15px; }
.git-credentials-head p { color: var(--text-muted); font-size: 13px; line-height: 1.5; margin: 0; }
.git-credentials-state { color: var(--text-muted); font-size: 13px; margin: 0; padding: 28px 12px; text-align: center; }
.git-credentials-error { align-items: center; color: var(--status-danger); display: flex; font-size: 13px; gap: 12px; justify-content: space-between; padding: 12px; }
.git-credential-list { display: grid; gap: 8px; }
.git-credential-row { align-items: center; background: var(--surface-inset); border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 12px; grid-template-columns: 38px minmax(0, 1fr) auto; padding: 12px; }
.git-credential-kind { align-items: center; color: var(--text-muted); display: flex; height: 38px; justify-content: center; width: 38px; }
.git-credential-copy { display: grid; gap: 5px; min-width: 0; }
.git-credential-title { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.git-credential-title strong { color: var(--text-strong); font-size: 14px; font-weight: 500; }
.git-credential-copy code { color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
.git-credential-copy small { color: var(--text-muted); font-size: 12px; }
.git-credential-actions { align-items: center; display: flex; gap: 6px; }
.git-credential-form { display: grid; gap: 12px; max-height: min(580px, var(--reka-dialog-content-available-height, 70vh)); overflow-y: auto; padding-right: 4px; }
.git-credential-form label { display: grid; gap: 6px; }
.git-credential-form label > span { color: var(--text-muted); font-size: 12px; }
.git-credential-form textarea { min-height: 96px; resize: vertical; }
.git-scope-fields { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 110px; }
.git-credentials-form-error { color: var(--status-danger); font-size: 12px; margin: 0; }
@media (max-width: 760px) {
  .git-credentials-head { align-items: stretch; flex-direction: column; }
  .git-credential-row { align-items: start; grid-template-columns: 32px minmax(0, 1fr); }
  .git-credential-actions { grid-column: 1 / -1; justify-content: flex-end; }
  .git-scope-fields { grid-template-columns: 1fr; }
}
</style>
