<template>
  <section class="proxy-management-panel">
    <div class="section-head compact-head">
      <div>
        <strong>{{ t("settings.controlPlaneProxy.managementTitle") }}</strong>
        <p>{{ t("settings.controlPlaneProxy.managementDescription") }}</p>
      </div>
      <div class="proxy-actions">
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refreshAll">
          <RefreshCw :size="14" />
          <span>{{ t("settings.nodeDetail.refresh") }}</span>
        </Button>
        <Button size="sm" :disabled="creating" @click="createInvite">
          <Plus :size="14" />
          <span>{{ creating ? t("settings.controlPlaneProxy.creatingInvite") : t("settings.controlPlaneProxy.createInvite") }}</span>
        </Button>
      </div>
    </div>

    <div class="proxy-trust-warning">
      <ShieldAlert :size="18" />
      <span>{{ t("settings.controlPlaneProxy.trustWarning") }}</span>
    </div>

    <div class="proxy-section">
      <h4>{{ invites.isLoading.value || invites.error.value ? t("settings.controlPlaneProxy.invitesTitle") : t("settings.controlPlaneProxy.invites", { count: nodeInvites.length }) }}</h4>
      <p v-if="invites.isLoading.value" class="proxy-empty" role="status">{{ t("settings.nodeDetail.loading") }}</p>
      <div v-else-if="invites.error.value" class="proxy-query-error" role="alert">
        <span>{{ queryError(invites.error.value) }}</span>
        <Button size="sm" variant="outline" @click="invites.refetch()">{{ t("common.actions.retry") }}</Button>
      </div>
      <ScrollArea v-else-if="nodeInvites.length" class="proxy-list" :horizontal="false">
        <div class="proxy-list-content">
          <div v-for="invite in nodeInvites" :key="invite.id" class="proxy-row">
            <div>
              <strong>{{ invite.id }}</strong>
              <span>{{ t("settings.controlPlaneProxy.inviteAudit", { createdBy: invite.createdBy, time: formatTime(invite.createdAt) }) }}</span>
              <span>{{ t("settings.controlPlaneProxy.expiresAt", { time: formatTime(invite.expiresAt) }) }}</span>
            </div>
            <div class="proxy-row-actions">
              <Badge :variant="invite.status === 'active' ? 'default' : 'secondary'">{{ t(`settings.controlPlaneProxy.inviteStatus.${invite.status}`) }}</Badge>
              <Button v-if="invite.status === 'active'" variant="outline" size="icon-sm" :aria-label="t('settings.controlPlaneProxy.revokeInvite')" @click="askRevoke('invite', invite.id)">
                <Trash2 :size="14" />
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>
      <p v-else class="proxy-empty">{{ t("settings.controlPlaneProxy.noInvites") }}</p>
    </div>

    <div class="proxy-section">
      <h4>{{ bindings.isLoading.value || bindings.error.value ? t("settings.controlPlaneProxy.bindingsTitle") : t("settings.controlPlaneProxy.bindings", { count: nodeBindings.length }) }}</h4>
      <p v-if="bindings.isLoading.value" class="proxy-empty" role="status">{{ t("settings.nodeDetail.loading") }}</p>
      <div v-else-if="bindings.error.value" class="proxy-query-error" role="alert">
        <span>{{ queryError(bindings.error.value) }}</span>
        <Button size="sm" variant="outline" @click="bindings.refetch()">{{ t("common.actions.retry") }}</Button>
      </div>
      <ScrollArea v-else-if="nodeBindings.length" class="proxy-list" :horizontal="false">
        <div class="proxy-list-content">
          <div v-for="binding in nodeBindings" :key="binding.id" class="proxy-row binding-row">
            <div>
              <strong>{{ binding.sourceControlPlaneId }}</strong>
              <span>{{ binding.id }} · {{ t("settings.controlPlaneProxy.revision", { revision: binding.revision }) }}</span>
              <code v-if="binding.lastError">{{ binding.lastError.code }} · {{ binding.lastError.message }}</code>
            </div>
            <div class="proxy-row-actions">
              <span v-if="diagnostics.isLoading.value" class="proxy-activity">{{ t("settings.nodeDetail.loading") }}</span>
              <span v-else-if="diagnostics.error.value" class="proxy-activity control-plane-error">{{ t("settings.controlPlaneProxy.activityUnavailable") }}</span>
              <span v-else class="proxy-activity">{{ t("settings.controlPlaneProxy.activity", { http: activity(binding.id).activeHttp, streams: activity(binding.id).activeStreams, webSockets: activity(binding.id).activeWebSockets }) }}</span>
              <Badge :variant="binding.status === 'active' ? 'default' : 'secondary'">{{ t(`settings.controlPlaneProxy.bindingStatus.${binding.status}`) }}</Badge>
              <Button v-if="binding.status === 'active'" variant="outline" size="icon-sm" :aria-label="t('settings.controlPlaneProxy.revokeBinding')" @click="askRevoke('binding', binding.id)">
                <Unplug :size="14" />
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>
      <p v-else class="proxy-empty">{{ t("settings.controlPlaneProxy.noBindings") }}</p>
      <div v-if="diagnostics.error.value && !bindings.error.value" class="proxy-query-error" role="alert">
        <span>{{ queryError(diagnostics.error.value) }}</span>
        <Button size="sm" variant="outline" @click="diagnostics.refetch()">{{ t("common.actions.retry") }}</Button>
      </div>
    </div>

    <GeneratedTokenDialog
      v-if="generatedInvite"
      :details="[
        { label: t('settings.controlPlaneProxy.proxyOrigin'), value: generatedInvite.proxyOrigin },
        { label: t('settings.controlPlaneProxy.targetNode'), value: nodeName },
      ]"
      :expires-at="generatedInvite.invite.expiresAt"
      :title="t('settings.controlPlaneProxy.inviteToken')"
      :token="generatedInvite.token"
      @close="generatedInvite = undefined"
    />

    <AlertDialog :open="Boolean(revokeTarget)" @update:open="(open) => !open && (revokeTarget = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("settings.controlPlaneProxy.revokeTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t(revokeTarget?.kind === 'binding' ? "settings.controlPlaneProxy.revokeBindingConfirm" : "settings.controlPlaneProxy.revokeInviteConfirm") }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <AlertDialogAction :disabled="revoking" @click="confirmRevoke">{{ t("settings.controlPlaneProxy.revoke") }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, ShieldAlert, Trash2, Unplug } from "@lucide/vue";
import {
  createControlPlaneProxyInvite,
  revokeControlPlaneProxyBinding,
  revokeControlPlaneProxyInvite,
  useControlPlaneProxyBindingsQuery,
  useControlPlaneProxyDiagnosticsQuery,
  useControlPlaneProxyInvitesQuery,
} from "../../../api/queries";
import type { CreateProxyInviteResult } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import GeneratedTokenDialog from "./GeneratedTokenDialog.vue";

const props = defineProps<{ nodeId: string; nodeName: string }>();
const { t } = useI18n();
const invites = useControlPlaneProxyInvitesQuery();
const bindings = useControlPlaneProxyBindingsQuery();
const diagnostics = useControlPlaneProxyDiagnosticsQuery();
const creating = ref(false);
const revoking = ref(false);
const generatedInvite = ref<CreateProxyInviteResult>();
const revokeTarget = ref<{ kind: "invite" | "binding"; id: string }>();
const nodeInvites = computed(() => (invites.data.value || []).filter((item) => item.targetNodeId === props.nodeId));
const nodeBindings = computed(() => (bindings.data.value || []).filter((item) => item.targetNodeId === props.nodeId));
const refreshing = computed(() => invites.isFetching.value || bindings.isFetching.value || diagnostics.isFetching.value);
const activity = (bindingId: string) => (diagnostics.data.value || []).find((item) => item.bindingId === bindingId) || { activeHttp: 0, activeStreams: 0, activeWebSockets: 0 };
const queryError = (error: unknown) => translateApiError(error, t);
const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

async function refreshAll() { await Promise.all([invites.refetch(), bindings.refetch(), diagnostics.refetch()]); }
async function createInvite() {
  creating.value = true;
  try {
    generatedInvite.value = await createControlPlaneProxyInvite({ targetNodeId: props.nodeId });
    await invites.refetch();
  } catch (error) { showControlPlaneToast(translateApiError(error, t)); }
  finally { creating.value = false; }
}
function askRevoke(kind: "invite" | "binding", id: string) { revokeTarget.value = { kind, id }; }
async function confirmRevoke() {
  if (!revokeTarget.value) return;
  revoking.value = true;
  try {
    if (revokeTarget.value.kind === "invite") await revokeControlPlaneProxyInvite(revokeTarget.value.id);
    else await revokeControlPlaneProxyBinding(revokeTarget.value.id);
    revokeTarget.value = undefined;
    await refreshAll();
  } catch (error) { showControlPlaneToast(translateApiError(error, t)); }
  finally { revoking.value = false; }
}
</script>

<style scoped>
.proxy-management-panel,
.proxy-section {
  display: grid;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.section-head strong {
  color: var(--text-strong);
  font-size: var(--node-detail-feature-title-size, 14px);
  font-weight: 700;
  line-height: 1.4;
}

.section-head p {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--node-detail-body-size, 12px);
  line-height: 1.5;
}

.proxy-actions,
.proxy-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.proxy-trust-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
  padding: 10px 12px;
  font-size: var(--node-detail-body-size, 12px);
  line-height: 1.5;
}

.proxy-trust-warning svg {
  flex: none;
  color: var(--warning, var(--text-muted));
}

.proxy-section h4 {
  margin: 4px 0 0;
  color: var(--text-strong);
  font-size: var(--node-detail-section-title-size, 13px);
  font-weight: 700;
  line-height: 1.5;
}

.proxy-list {
  max-height: min(260px, var(--reka-scroll-area-viewport-height, 260px));
}

.proxy-list-content {
  min-width: 0;
  padding-right: 10px;
}

.proxy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding: 10px 0;
}

.proxy-row > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.proxy-row strong,
.proxy-row span,
.proxy-row code {
  overflow-wrap: anywhere;
  font-size: var(--node-detail-body-size, 12px);
  line-height: 1.5;
}

.proxy-row strong {
  color: var(--text-strong);
  font-weight: 700;
}

.proxy-row span,
.proxy-activity {
  color: var(--text-muted);
}

.proxy-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--node-detail-body-size, 12px);
  line-height: 1.5;
}

.proxy-query-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  color: var(--status-danger);
  font-size: var(--node-detail-body-size, 12px);
  line-height: 1.5;
}

.proxy-query-error span {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 720px) {
  .section-head,
  .proxy-row {
    align-items: stretch;
    flex-direction: column;
  }

  .proxy-actions {
    justify-content: flex-start;
  }
}
</style>
