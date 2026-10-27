<template>
  <section class="cloud-relay-panel" :class="{ 'cloud-relay-panel-embedded': embedded }">
    <header class="cloud-relay-panel-head">
      <span>{{ t("settings.nodeDetail.cloudRelayTitle") }}</span>
      <Button variant="outline" size="sm" :disabled="relay.isFetching.value" @click="relay.refetch()">
        <RefreshCw :size="14" />
        <span>{{ t("settings.nodeDetail.refresh") }}</span>
      </Button>
    </header>
    <div class="cloud-relay-panel-list">
      <div class="cloud-relay-panel-row">
        <div>
          <strong>{{ t("settings.nodeDetail.cloudRelayTitle") }}</strong>
          <code>{{ t("settings.nodeDetail.connectionCloudRelay") }}</code>
        </div>
        <Badge :variant="channel?.connected ? 'default' : 'secondary'">
          {{ channel?.connected ? t("settings.nodeDetail.cloudRelayConnected") : t("settings.nodeDetail.cloudRelayWaiting") }}
        </Badge>
      </div>
      <div v-if="lastError" class="cloud-relay-panel-row">
        <div>
          <strong>{{ t("settings.nodeDetail.cloudRelayLastError") }}</strong>
          <code>{{ lastError }}</code>
        </div>
      </div>
    </div>
    <div class="cloud-relay-panel-actions">
      <Button variant="outline" size="sm" :disabled="busy || !channelNodeHandle" @click="unbind">
        <Unplug :size="14" />
        <span>{{ t("settings.nodeDetail.cloudRelayUnbind") }}</span>
      </Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { RefreshCw, Unplug } from "@lucide/vue";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { controlPlaneQueryKeys, releaseCloudAccountNodeClaim, useCloudNodeRelayQuery } from "../../../api/queries";
import type { Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ selectedNode: Node; embedded?: boolean }>();
const { t } = useI18n();
const queryClient = useQueryClient();
const busy = ref(false);
const relay = useCloudNodeRelayQuery({ refetchIntervalMs: () => 3_000 });
const channelNodeHandle = computed(() => props.selectedNode.connectionPath?.kind === "cloud-relay" ? props.selectedNode.connectionPath.nodeHandle : "");
const channel = computed(() => relay.data.value?.channels.find((item) => item.nodeHandle === channelNodeHandle.value));
const lastError = computed(() => relay.data.value?.errors.find((item) => item.nodeHandle === channelNodeHandle.value)?.message
  || props.selectedNode.labels["cloudRelayLastError"]
  || "");

async function unbind() {
  if (!channelNodeHandle.value || busy.value) return;
  if (!window.confirm(t("settings.nodeDetail.cloudRelayUnbindConfirm"))) return;
  busy.value = true;
  try {
    await releaseCloudAccountNodeClaim(channelNodeHandle.value);
    showControlPlaneToast(t("settings.nodeDetail.cloudRelayUnbindDone"), "success");
    await Promise.all([
      relay.refetch(),
      queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes }),
    ]);
  } catch (error) {
    showControlPlaneToast(`${t("settings.nodeDetail.cloudRelayUnbindFailed")} ${translateApiError(error, t)}`, "error");
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.cloud-relay-panel {
  display: grid;
  gap: 0;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}

.cloud-relay-panel-embedded {
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.cloud-relay-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--line);
  padding: 8px 12px;
}

.cloud-relay-panel-head > span {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-relay-panel-list { display: grid; }

.cloud-relay-panel-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 10px 12px;
}

.cloud-relay-panel-row + .cloud-relay-panel-row { border-top: 1px solid var(--line); }

.cloud-relay-panel-row > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.cloud-relay-panel-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-relay-panel-row code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-relay-panel-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--line);
  padding: 10px 12px;
}

@media (max-width: 720px) {
  .cloud-relay-panel-head { align-items: flex-start; flex-direction: column; }
}
</style>
