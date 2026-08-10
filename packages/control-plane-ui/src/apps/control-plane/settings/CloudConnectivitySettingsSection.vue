<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content cloud-connectivity-settings">
      <section class="modal-section settings-panel-surface cloud-panel">
        <header class="cloud-head">
          <div><strong>{{ t("settings.cloud.title") }}</strong><p>{{ t("settings.cloud.description") }}</p></div>
          <Badge :variant="state?.status === 'active' ? 'default' : 'secondary'">{{ statusLabel }}</Badge>
        </header>
        <div v-if="query.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</div>
        <div v-else-if="query.error.value" class="cloud-error" role="alert"><span>{{ errorText(query.error.value) }}</span><Button variant="outline" size="sm" @click="query.refetch()">{{ t("common.actions.retry") }}</Button></div>
        <template v-else-if="state">
          <dl class="cloud-identity">
            <div><dt>{{ t("settings.cloud.controlPlaneId") }}</dt><dd>{{ state.identity.controlPlaneId }}</dd></div>
            <div><dt>{{ t("settings.cloud.fingerprint") }}</dt><dd><code>{{ state.identity.fingerprint }}</code></dd></div>
            <div v-if="state.bindingRevision"><dt>{{ t("settings.cloud.revision") }}</dt><dd>{{ state.bindingRevision }}</dd></div>
            <div><dt>{{ t("settings.cloud.background") }}</dt><dd>{{ state.hasBackgroundCredential ? t("settings.cloud.running") : t("settings.cloud.notConnected") }}</dd></div>
          </dl>
          <p class="cloud-note">{{ t("settings.cloud.backgroundNote") }}</p>
          <div v-if="challenge" class="cloud-challenge" role="status">
            <strong>{{ t("settings.cloud.challengeOnce") }}</strong><code>{{ challenge.challengeCode }}</code><small>{{ t("settings.cloud.challengeExpires", { time: formatExpiry(challenge.payload.expiresAt) }) }}</small>
          </div>
          <div class="cloud-actions">
            <Button v-if="state.status === 'unbound' || state.status === 'pending-claim'" :disabled="busy" @click="beginBinding">{{ busy ? t("settings.cloud.creating") : t("settings.cloud.connect") }}</Button>
            <Button v-if="state.status === 'active'" variant="outline" :disabled="busy" @click="setRemoteAccess(!state.remoteAccessEnabled)">{{ state.remoteAccessEnabled ? t("settings.cloud.disableRemote") : t("settings.cloud.enableRemote") }}</Button>
            <Button v-if="state.status !== 'unbound'" variant="destructive" :disabled="busy" @click="disconnect">{{ t("settings.cloud.disconnect") }}</Button>
          </div>
          <p v-if="state.remoteResult === 'unknown' || state.status === 'pending-revocation'" class="cloud-warning" role="status">{{ t("settings.cloud.resultUnknown") }}</p>
          <p v-if="state.status === 'clone-conflict'" class="cloud-warning" role="alert">{{ t("settings.cloud.cloneConflict") }}</p>
        </template>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { createCloudBindingChallenge, disconnectCloudAccount, updateCloudRemoteAccess, useCloudConnectivityQuery } from "../../../api/queries";
import type { CloudBindingChallenge } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const { locale, t } = useI18n(); const query = useCloudConnectivityQuery(); const challenge = ref<CloudBindingChallenge>(); const busy = ref(false);
const state = computed(() => query.data.value); const statusLabel = computed(() => state.value ? t(`settings.cloud.status.${state.value.status}`) : "");
const errorText = (error: unknown) => translateApiError(error, t, t("settings.cloud.loadFailed"));
const formatExpiry = (value: string) => new Intl.DateTimeFormat(locale.value, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
async function beginBinding(){busy.value=true;try{challenge.value=await createCloudBindingChallenge();window.open(challenge.value.authorizationUrl,"_blank","noopener,noreferrer");await navigator.clipboard?.writeText(challenge.value.challengeCode);await query.refetch()}catch(error){showControlPlaneToast(errorText(error))}finally{busy.value=false}}
async function setRemoteAccess(enabled:boolean){busy.value=true;try{await updateCloudRemoteAccess(enabled);await query.refetch()}catch(error){showControlPlaneToast(errorText(error))}finally{busy.value=false}}
async function disconnect(){if(!window.confirm(t("settings.cloud.disconnectConfirm")))return;busy.value=true;try{await disconnectCloudAccount();challenge.value=undefined;await query.refetch()}catch(error){showControlPlaneToast(errorText(error))}finally{busy.value=false}}
</script>

<style scoped>
.cloud-connectivity-settings{max-width:920px}.cloud-panel{align-content:start}.cloud-head{align-items:flex-start;display:flex;gap:16px;justify-content:space-between}.cloud-head>div{display:grid;gap:4px}.cloud-head strong{color:var(--text-strong);font-size:15px}.cloud-head p,.cloud-note{color:var(--text-muted);font-size:13px;line-height:1.5;margin:0}.cloud-state{color:var(--text-muted);font-size:13px;padding:28px;text-align:center}.cloud-error{align-items:center;color:var(--status-danger);display:flex;font-size:13px;justify-content:space-between}.cloud-identity{background:var(--surface-inset);border:1px solid var(--line);border-radius:8px;display:grid;margin:0;padding:12px}.cloud-identity>div{display:grid;gap:8px;grid-template-columns:150px minmax(0,1fr);padding:7px}.cloud-identity dt{color:var(--text-muted);font-size:12px}.cloud-identity dd{color:var(--text);font-size:13px;margin:0;min-width:0;overflow-wrap:anywhere}.cloud-identity code,.cloud-challenge code{font-size:12px}.cloud-challenge{background:var(--surface-active);border:1px solid var(--line);border-radius:8px;display:grid;gap:7px;padding:12px}.cloud-challenge strong,.cloud-challenge small{font-size:12px}.cloud-actions{display:flex;flex-wrap:wrap;gap:8px}.cloud-warning{color:var(--status-warning);font-size:13px;margin:0}@media(max-width:720px){.cloud-head{align-items:stretch;flex-direction:column}.cloud-identity>div{grid-template-columns:1fr;gap:2px}}
</style>
