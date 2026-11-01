<template>
  <section class="modal-section settings-panel-surface cloud-node-pending-detail">
    <header>
      <div class="cloud-node-pending-heading">
        <h3>{{ displayName }}</h3>
        <Badge variant="secondary">{{ t(`settings.nodeRelay.nodeTrust.status.${trust.state}`) }}</Badge>
      </div>
      <div class="cloud-node-pending-actions">
        <Button v-if="canReapply" variant="outline" size="sm" :disabled="busy || waitingForReapply" :aria-busy="reapplyLoading" @click="reapply">
          <LoaderCircle v-if="reapplyLoading" class="cloud-node-pending-spinner" :size="14" />
          <RefreshCw v-else :size="14" />
          {{ reapplying ? t("settings.nodeRelay.nodeTrust.reapplying") : waitingForReapply ? t("settings.nodeRelay.nodeTrust.reapplyWaiting") : t("settings.nodeRelay.nodeTrust.reapply") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="emit('refresh')"><RefreshCw :size="14" />{{ t("common.actions.refresh") }}</Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="cancelJoin">{{ t("settings.nodeRelay.nodeTrust.cancelAdd") }}</Button>
      </div>
    </header>
    <ScrollArea class="cloud-node-pending-scroll" :horizontal="false">
      <div class="cloud-node-pending-content">
        <CloudNodeTrustStatus
          :phase="cloudNodeTrustPhase(trust)"
          :trust="trust"
          :display-name="displayName"
          :node-handle="trust.nodeHandle"
          :error="error"
          hide-actions
          hide-node-label
          @retry="emit('refresh')"
          @cancel="cancelJoin"
        />
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <p v-if="actionMessage" class="cloud-node-pending-message" role="status" aria-live="polite">
          <LoaderCircle v-if="waitingForReapply" class="cloud-node-pending-spinner" :size="14" aria-hidden="true" />
          <span>{{ actionMessage }}</span>
        </p>
      </div>
    </ScrollArea>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { reapplyCloudAccountNodeClaim, releaseCloudAccountNodeClaim } from "../../../api/queries";
import type { CloudNodeRelayTrust } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import CloudNodeTrustStatus from "./CloudNodeTrustStatus.vue";
import { cloudNodeTrustPhase } from "./cloudNodeTrust";

const props = defineProps<{ trust: CloudNodeRelayTrust; displayName?: string; error?: string }>();
const emit = defineEmits<{ refresh: []; cancelled: [nodeHandle: string] }>();
const { t } = useI18n();
const busy = ref(false);
const reapplying = ref(false);
const waitingForReapply = ref(false);
const actionError = ref("");
const actionMessage = ref("");
const REAPPLY_RESPONSE_TIMEOUT_MS = 30_000;
let reapplyTimeout: ReturnType<typeof setTimeout> | undefined;
let submittedRequestId: string | undefined;
const displayName = computed(() => props.displayName || props.trust.displayName || props.trust.nodeHandle);
const canReapply = computed(() => props.trust.state === "rejected" || props.trust.state === "expired");
const reapplyLoading = computed(() => reapplying.value || waitingForReapply.value);

function clearReapplyWait() {
  if (reapplyTimeout) clearTimeout(reapplyTimeout);
  reapplyTimeout = undefined;
  waitingForReapply.value = false;
}

function beginReapplyWait(previousRequestId: string | undefined) {
  const receivedNewRequest = props.trust.state === "pending"
    || (Boolean(props.trust.requestId) && props.trust.requestId !== previousRequestId);
  if (receivedNewRequest) return;
  clearReapplyWait();
  submittedRequestId = previousRequestId;
  waitingForReapply.value = true;
  actionMessage.value = t("settings.nodeRelay.nodeTrust.reapplySubmitted");
  reapplyTimeout = setTimeout(() => {
    reapplyTimeout = undefined;
    waitingForReapply.value = false;
    actionMessage.value = "";
    actionError.value = t("settings.nodeRelay.nodeTrust.reapplyNoResponse");
    emit("refresh");
  }, REAPPLY_RESPONSE_TIMEOUT_MS);
}

watch(() => [props.trust.requestId, props.trust.state] as const, ([requestId, state]) => {
  if (!waitingForReapply.value) return;
  if (state !== "pending" && requestId === submittedRequestId) return;
  clearReapplyWait();
  actionMessage.value = "";
});

onBeforeUnmount(clearReapplyWait);

async function reapply() {
  if (busy.value || waitingForReapply.value) return;
  busy.value = true;
  reapplying.value = true;
  clearReapplyWait();
  actionError.value = "";
  actionMessage.value = "";
  const previousRequestId = props.trust.requestId;
  try {
    await reapplyCloudAccountNodeClaim(props.trust.nodeHandle);
    beginReapplyWait(previousRequestId);
    emit("refresh");
  } catch (error) {
    actionError.value = translateApiError(error, t);
  } finally {
    reapplying.value = false;
    busy.value = false;
  }
}

async function cancelJoin() {
  if (busy.value) return;
  const nodeHandle = props.trust.nodeHandle;
  busy.value = true;
  clearReapplyWait();
  actionError.value = "";
  actionMessage.value = "";
  try {
    await releaseCloudAccountNodeClaim(nodeHandle);
    emit("cancelled", nodeHandle);
  } catch (error) {
    actionError.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.cloud-node-pending-detail { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 0; height: 100%; max-height: 100%; min-width: 0; min-height: 0; overflow: hidden; padding: 0; border: 0; border-radius: 0; background: transparent; }
.cloud-node-pending-detail > header { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 0 8px; border-bottom: 1px solid var(--line); }
.cloud-node-pending-heading, .cloud-node-pending-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.cloud-node-pending-actions { margin-left: auto; }
.cloud-node-pending-detail h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 500; }
.cloud-node-pending-scroll { min-height: 0; }
.cloud-node-pending-content { display: grid; gap: 12px; padding: 8px 0 20px; }
.cloud-node-pending-content > p { margin: 0; color: var(--status-danger); font-size: 12px; }
.cloud-node-pending-content > p.cloud-node-pending-message { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
.cloud-node-pending-message svg { flex: 0 0 auto; }
.cloud-node-pending-spinner { animation: cloud-node-pending-spin 0.8s linear infinite; }
@keyframes cloud-node-pending-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cloud-node-pending-spinner { animation: none; } }
</style>
