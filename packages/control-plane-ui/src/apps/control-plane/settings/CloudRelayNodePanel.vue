<template>
  <div class="node-remote-panel">
    <div class="section-head has-actions">
      <span>{{ t("settings.nodeDetail.cloudRelayTitle") }}</span>
      <Button variant="outline" size="sm" :disabled="relay.isFetching.value" @click="relay.refetch()">
        <RefreshCw :size="14" />
        <span>{{ t("settings.nodeDetail.refresh") }}</span>
      </Button>
    </div>
    <div class="node-resource-list">
      <div class="node-resource-row">
        <div>
          <strong>{{ t("settings.nodeDetail.cloudRelayTitle") }}</strong>
          <code>{{ t("settings.nodeDetail.connectionCloudRelay") }}</code>
        </div>
        <Badge :variant="channel?.connected ? 'default' : 'secondary'">
          {{ channel?.connected ? t("settings.nodeDetail.cloudRelayConnected") : t("settings.nodeDetail.cloudRelayWaiting") }}
        </Badge>
      </div>
      <div v-if="lastError" class="node-resource-row">
        <div>
          <strong>{{ t("settings.nodeDetail.cloudRelayLastError") }}</strong>
          <code>{{ lastError }}</code>
        </div>
      </div>
    </div>
    <div class="settings-row-actions">
      <Button variant="outline" size="sm" :disabled="busy || !channelNodeHandle" @click="unbind">
        <Unplug :size="14" />
        <span>{{ t("settings.nodeDetail.cloudRelayUnbind") }}</span>
      </Button>
    </div>
  </div>
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

const props = defineProps<{ selectedNode: Node }>();
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
