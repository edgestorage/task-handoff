<template>
  <section class="cloud-node-trust-panel" :class="{ 'cloud-node-trust-panel-embedded': embedded }">
    <header class="cloud-node-trust-head">
      <span>{{ t("settings.nodeDetail.cloudRelayTrustedControlPlanes", { count: activePins.length }) }}</span>
      <Button variant="outline" size="sm" :disabled="trust.isFetching.value" @click="trust.refetch()">
        <RefreshCw :size="14" />
        <span>{{ t("settings.nodeDetail.refresh") }}</span>
      </Button>
    </header>
    <p v-if="trust.isLoading.value && !trust.data.value" class="cloud-node-trust-state" role="status">{{ t("settings.nodeDetail.cloudRelayTrustLoading") }}</p>
    <div v-else-if="trust.error.value && !trust.data.value" class="cloud-node-trust-error" role="alert">
      <span>{{ t("settings.nodeDetail.cloudRelayTrustLoadFailed") }} {{ translateApiError(trust.error.value, t) }}</span>
      <Button variant="outline" size="sm" @click="trust.refetch()">{{ t("common.actions.retry") }}</Button>
    </div>
    <p v-else-if="!activePins.length" class="cloud-node-trust-state">{{ t("settings.nodeDetail.cloudRelayTrustEmpty") }}</p>
    <div v-else class="cloud-node-trust-list">
      <div v-for="pin in activePins" :key="pin.pinId" class="cloud-node-trust-row">
        <div>
          <strong :title="pin.controlPlaneId">{{ pin.controlPlaneId }}</strong>
          <small>{{ t("settings.nodeDetail.cloudRelayTrustLastSeen", { time: formatTrustDate(pin.lastSeenAt) }) }}</small>
        </div>
        <div class="cloud-node-trust-actions">
          <Badge :variant="isCurrentPin(pin) ? 'default' : 'secondary'">{{ isCurrentPin(pin) ? t("settings.nodeDetail.cloudRelayTrustCurrent") : t("settings.nodeDetail.cloudRelayTrustActive") }}</Badge>
          <Button
            variant="outline"
            size="sm"
            :disabled="revokeDisabled(pin)"
            :title="revokeHint(pin)"
            @click="requestRevoke(pin)"
          >
            <Trash2 :size="14" />
            <span>{{ t("settings.nodeDetail.cloudRelayTrustRevoke") }}</span>
          </Button>
        </div>
      </div>
    </div>
  </section>

  <Dialog :open="Boolean(pendingRevoke)" @update:open="(open) => { if (!open && !revokingId) pendingRevoke = undefined; }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.nodeDetail.cloudRelayTrustRevokeTitle", { name: pendingRevoke?.pin.controlPlaneId || "" }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.nodeDetail.cloudRelayTrustRevokeDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(revokingId)" @click="pendingRevoke = undefined">{{ t("common.actions.cancel") }}</Button>
        <Button variant="destructive" :disabled="Boolean(revokingId) || !canRevokeTarget" @click="revokeTrust">{{ revokingId ? t("settings.nodeDetail.cloudRelayTrustRevoking") : t("settings.nodeDetail.cloudRelayTrustRevoke") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import { RefreshCw, Trash2 } from "@lucide/vue";
import type { NodeAgentControlPlaneTrustPin } from "@task-handoff/protocol/node-agent-control-plane-trust";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import {
  nodeControlPlaneTrustQueryOptions,
  revokeNodeControlPlaneTrust,
  useCloudConnectivityQuery,
} from "../../../api/queries";
import type { Node } from "../../../api/types";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ canManageSettings: boolean; selectedNode: Node; embedded?: boolean }>();
const { t, locale } = useI18n();
const pendingRevoke = ref<{ nodeId: string; pin: NodeAgentControlPlaneTrustPin }>();
const revokingId = ref("");
const cloud = useCloudConnectivityQuery();
const trust = useQuery(computed(() => nodeControlPlaneTrustQueryOptions(props.selectedNode.id, props.canManageSettings)));
const activePins = computed(() => [...(trust.data.value?.pins ?? [])]
  .filter((pin) => pin.status === "active")
  .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.pinId.localeCompare(right.pinId)));
const cloudControlPlaneId = computed(() => cloud.data.value?.cloudControlPlaneId);
const isCurrentPin = (pin: NodeAgentControlPlaneTrustPin) => Boolean(cloudControlPlaneId.value && pin.controlPlaneId === cloudControlPlaneId.value);
const canRevokeTarget = computed(() => Boolean(pendingRevoke.value && cloudControlPlaneId.value && !isCurrentPin(pendingRevoke.value.pin)));
const formatTrustDate = (value: string) => formatDateTime(value, locale.value as SupportedLocale);

function revokeDisabled(pin: NodeAgentControlPlaneTrustPin) {
  return Boolean(revokingId.value) || !cloudControlPlaneId.value || isCurrentPin(pin);
}

function revokeHint(pin: NodeAgentControlPlaneTrustPin) {
  if (isCurrentPin(pin)) return t("settings.nodeDetail.cloudRelayTrustCurrentHint");
  return cloudControlPlaneId.value ? undefined : t("settings.nodeDetail.cloudRelayTrustCurrentUnknownHint");
}

watch(() => props.selectedNode.id, () => {
  pendingRevoke.value = undefined;
});

function requestRevoke(pin: NodeAgentControlPlaneTrustPin) {
  if (revokingId.value || !cloudControlPlaneId.value || isCurrentPin(pin)) return;
  pendingRevoke.value = { nodeId: props.selectedNode.id, pin };
}

async function revokeTrust() {
  const target = pendingRevoke.value;
  if (!target || revokingId.value || !cloudControlPlaneId.value || isCurrentPin(target.pin)) return;
  const targetNodeId = target.nodeId;
  const targetPin = target.pin;
  revokingId.value = targetPin.pinId;
  try {
    await revokeNodeControlPlaneTrust(targetNodeId, targetPin.pinId, {
      expectedFingerprint: targetPin.fingerprint,
      expectedRevision: targetPin.revision,
    });
    pendingRevoke.value = undefined;
    showControlPlaneToast(t("settings.nodeDetail.cloudRelayTrustRevokeDone", { name: targetPin.controlPlaneId }), "success");
    await trust.refetch();
  } catch (error) {
    showControlPlaneToast(`${t("settings.nodeDetail.cloudRelayTrustRevokeFailed")} ${translateApiError(error, t)}`, "error");
    pendingRevoke.value = undefined;
    await trust.refetch().catch(() => undefined);
  } finally {
    revokingId.value = "";
  }
}
</script>

<style scoped>
.cloud-node-trust-panel {
  display: grid;
  gap: 0;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}

.cloud-node-trust-panel-embedded {
  overflow: visible;
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
}

.cloud-node-trust-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--line);
  padding: 8px 12px;
}

.cloud-node-trust-head > span {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-node-trust-list { display: grid; }

.cloud-node-trust-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 10px 12px;
}

.cloud-node-trust-row + .cloud-node-trust-row { border-top: 1px solid var(--line); }

.cloud-node-trust-row > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.cloud-node-trust-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-node-trust-row small {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.cloud-node-trust-row > .cloud-node-trust-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.cloud-node-trust-state {
  margin: 0;
  padding: 24px 12px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.cloud-node-trust-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 10px 12px;
  color: var(--status-danger);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .cloud-node-trust-head { align-items: flex-start; flex-direction: column; }
  .cloud-node-trust-row { grid-template-columns: 1fr; gap: 8px; }
  .cloud-node-trust-row > .cloud-node-trust-actions { justify-content: flex-start; }
}
</style>
