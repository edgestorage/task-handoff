<template>
  <section class="browser-profiles">
    <div class="browser-profiles-heading">
      <div class="browser-profiles-heading-copy">
        <h3>{{ t("instances.settings.browserProfilesTitle") }}</h3>
        <p>{{ t("instances.settings.browserProfilesDescription") }}</p>
      </div>
      <Button v-if="showList" size="icon" variant="ghost" class="browser-profiles-refresh" :aria-label="t('instances.settings.refreshBrowserProfiles')" :disabled="query.isFetching.value" @click="refresh">
        <RefreshCw :class="{ 'animate-spin motion-reduce:animate-none': query.isFetching.value }" :size="14" />
      </Button>
    </div>

    <div class="browser-profiles-surface">
      <div v-if="!installed" class="browser-profiles-state">
        <p>{{ t(installStateKey) }}</p>
        <Button size="sm" variant="outline" @click="emit('open-apps')">{{ t("instances.settings.browserGoToApps") }}</Button>
      </div>
      <div v-else-if="!supported" class="browser-profiles-state">{{ t("instances.settings.browserProfilesUnsupported") }}</div>
      <div v-else-if="query.isPending.value" class="browser-profiles-state">{{ t("instances.settings.browserProfilesLoading") }}</div>
      <div v-else-if="query.isError.value" class="browser-profiles-state browser-profiles-state-error" role="alert">
        <span>{{ errorText(query.error.value) }}</span>
        <Button size="sm" variant="outline" @click="refresh">{{ t("instances.settings.retry") }}</Button>
      </div>
      <template v-else>
        <div class="browser-profiles-create">
          <ControlPlaneInput v-model="newProfileName" maxlength="60" :placeholder="t('instances.settings.browserProfileNamePlaceholder')" :disabled="creating" @keydown.enter="createProfile" />
          <Button size="sm" :disabled="creating || !newProfileName.trim()" @click="createProfile">{{ creating ? t("instances.settings.creating") : t("instances.settings.browserProfileCreate") }}</Button>
        </div>
        <p v-if="actionError" class="browser-profiles-error" role="alert">{{ actionError }}</p>
        <ul class="browser-profiles-list">
          <li v-for="profile in profiles" :key="profile.id" class="browser-profiles-row">
            <div class="browser-profiles-main">
              <div class="browser-profiles-identity">
                <span class="browser-profiles-name">
                  <strong>{{ profileLabel(profile) }}</strong>
                  <Badge v-if="profile.isDefault && !usesDefaultProfileName(profile)" variant="secondary">{{ t("instances.settings.browserProfileDefault") }}</Badge>
                  <Badge v-if="profile.runningSessionId" variant="default">{{ t("instances.settings.browserProfileRunning") }}</Badge>
                </span>
                <small>{{ diskUsageLabel(profile) }}</small>
              </div>
              <div class="browser-profiles-controls">
                <Button v-if="profile.runningSessionId" size="sm" variant="outline" @click="emit('open-session', profile.runningSessionId)">{{ t("instances.settings.browserProfileOpenSession") }}</Button>
                <Button v-else-if="!profile.isDefault" size="sm" variant="ghost" :disabled="busyProfileId === profile.id" @click="setDefault(profile)">{{ t("instances.settings.browserProfileSetDefault") }}</Button>
                <Button size="sm" variant="ghost" :disabled="busyProfileId === profile.id" @click="startRename(profile)">{{ t("instances.settings.browserProfileRename") }}</Button>
                <Button size="sm" variant="ghost" :disabled="profile.isDefault || Boolean(profile.runningSessionId) || busyProfileId === profile.id" @click="deleteTarget = profile">{{ t("instances.settings.browserProfileDelete") }}</Button>
              </div>
            </div>
            <div v-if="renamingProfileId === profile.id" class="browser-profiles-rename">
              <ControlPlaneInput v-model="renameDraft" maxlength="60" :disabled="busyProfileId === profile.id" @keydown.enter="rename(profile)" />
              <Button size="sm" :disabled="busyProfileId === profile.id || !renameDraft.trim()" @click="rename(profile)">{{ t("instances.settings.save") }}</Button>
              <Button size="sm" variant="ghost" @click="cancelRename">{{ t("instances.settings.cancel") }}</Button>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <AlertDialog :open="Boolean(deleteTarget)" @update:open="(open) => { if (!open) deleteTarget = undefined }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("instances.settings.browserProfileDeleteTitle", { name: deleteTarget?.name || "" }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("instances.settings.browserProfileDeleteDescription") }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="Boolean(busyProfileId)">{{ t("instances.settings.cancel") }}</AlertDialogCancel>
          <Button variant="destructive" :disabled="Boolean(busyProfileId)" @click="confirmDelete">{{ busyProfileId ? t("instances.settings.deleting") : t("instances.settings.browserProfileDelete") }}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import type { AppProfile } from "@task-handoff/protocol/app-profiles";
import type { AppManagementSnapshot, InstanceBoardItem } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import { formatBytes } from "../../../i18n/presentation";
import { translateApiError } from "../../../i18n/apiError";
import { useControlPlaneLocale } from "../../../i18n/index";
import { BROWSER_PROFILE_APP_ID, browserProfileApp, supportsBrowserProfiles, useBrowserProfiles, usesDefaultProfileName } from "../useBrowserProfiles";

const props = defineProps<{
  instance: InstanceBoardItem;
  appManagement?: AppManagementSnapshot;
  appId?: string;
}>();

const emit = defineEmits<{
  "open-apps": [];
  "open-session": [sessionId: string];
}>();

const { t } = useI18n();
const { locale } = useControlPlaneLocale();
const appId = computed(() => props.appId || BROWSER_PROFILE_APP_ID);
const managementApp = computed(() => props.appManagement?.apps.find((app) => app.id === appId.value));
const installed = computed(() => {
  const app = managementApp.value;
  if (app) return app.state === "installed";
  const inventory = browserProfileApp(props.instance, appId.value);
  return inventory ? inventory.availability === "available" : true;
});
const installStateKey = computed(() => managementApp.value?.state === "broken"
  ? "instances.settings.browserNeedsAttention"
  : "instances.settings.browserNotInstalled");
const supported = computed(() => supportsBrowserProfiles(props.instance, appId.value));
const showList = computed(() => installed.value && supported.value);

const { query, profiles, refresh, createProfile: createProfileRequest, renameProfile, setDefaultProfile, removeProfile } = useBrowserProfiles({
  instanceId: () => props.instance.id,
  appId,
  enabled: showList,
});

const newProfileName = ref("");
const renameDraft = ref("");
const renamingProfileId = ref("");
const busyProfileId = ref("");
const actionError = ref("");
const creating = ref(false);
const deleteTarget = ref<AppProfile>();

function errorText(error: unknown) {
  return translateApiError(error, t, t("instances.settings.browserProfilesFailed"));
}

/** The untouched default profile shows the localized name instead of the placeholder. */
function profileLabel(profile: AppProfile) {
  return usesDefaultProfileName(profile) ? t("instances.settings.browserProfileDefaultName") : profile.name;
}

function diskUsageLabel(profile: AppProfile) {
  return profile.diskUsageBytes === undefined
    ? t("instances.settings.browserProfileDiskUnknown")
    : t("instances.settings.browserProfileDiskUsage", { size: formatBytes(profile.diskUsageBytes, locale.value) });
}

async function createProfile() {
  const name = newProfileName.value.trim();
  if (!name || creating.value) return;
  creating.value = true;
  actionError.value = "";
  try {
    await createProfileRequest(name);
    newProfileName.value = "";
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    creating.value = false;
  }
}

function startRename(profile: AppProfile) {
  renamingProfileId.value = profile.id;
  // Seed with what the row shows, so renaming the untouched default starts
  // from the localized label instead of the placeholder value.
  renameDraft.value = profileLabel(profile);
  actionError.value = "";
}

function cancelRename() {
  renamingProfileId.value = "";
  renameDraft.value = "";
}

async function rename(profile: AppProfile) {
  const name = renameDraft.value.trim();
  if (!name || busyProfileId.value) return;
  busyProfileId.value = profile.id;
  actionError.value = "";
  try {
    await renameProfile(profile.id, name);
    cancelRename();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busyProfileId.value = "";
  }
}

async function setDefault(profile: AppProfile) {
  if (busyProfileId.value) return;
  busyProfileId.value = profile.id;
  actionError.value = "";
  try {
    await setDefaultProfile(profile.id);
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busyProfileId.value = "";
  }
}

async function confirmDelete() {
  const profile = deleteTarget.value;
  if (!profile || busyProfileId.value) return;
  busyProfileId.value = profile.id;
  actionError.value = "";
  try {
    await removeProfile(profile.id);
    deleteTarget.value = undefined;
  } catch (error) {
    actionError.value = errorText(error);
    deleteTarget.value = undefined;
  } finally {
    busyProfileId.value = "";
  }
}
</script>

<style scoped>
.browser-profiles {
  display: grid;
  gap: 12px;
}

.browser-profiles-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.browser-profiles-heading-copy {
  display: grid;
  gap: 3px;
}

.browser-profiles-heading-copy h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.browser-profiles-heading-copy p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.browser-profiles-refresh {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
}

.browser-profiles-surface {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
}

.browser-profiles-state {
  display: flex;
  min-height: 112px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 18px;
  text-align: center;
}

.browser-profiles-state p {
  margin: 0;
}

.browser-profiles-state-error {
  color: var(--status-danger);
}

.browser-profiles-create {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  padding: 10px 12px;
}

.browser-profiles-create :deep(input) {
  max-width: 280px;
}

.browser-profiles-error {
  margin: 0;
  border-bottom: 1px solid var(--line);
  color: var(--status-danger);
  font-size: 12px;
  padding: 8px 12px;
}

.browser-profiles-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.browser-profiles-row {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
}

.browser-profiles-row + .browser-profiles-row {
  border-top: 1px solid var(--line);
}

.browser-profiles-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.browser-profiles-identity {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.browser-profiles-name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.browser-profiles-name strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-profiles-identity small {
  color: var(--text-muted);
  font-size: 12px;
}

.browser-profiles-controls {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.browser-profiles-rename {
  display: flex;
  align-items: center;
  gap: 8px;
}

.browser-profiles-rename :deep(input) {
  max-width: 280px;
}
</style>
