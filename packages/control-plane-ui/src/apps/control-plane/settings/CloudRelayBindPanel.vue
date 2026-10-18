<template>
  <div class="node-remote-panel">
    <div class="section-head has-actions">
      <span>{{ t("settings.nodeDetail.cloudRelayBindTitle") }}</span>
      <Button variant="outline" size="sm" :disabled="busy || !available" @click="bind">
        <Cloud :size="14" />
        <span>{{ busy ? t("settings.nodeDetail.cloudRelayBindBusy") : t("settings.nodeDetail.cloudRelayBindAction") }}</span>
      </Button>
    </div>
    <div class="node-detail-section-body">
      <p class="node-detail-hint">{{ available ? t("settings.nodeDetail.cloudRelayBindHint") : t("settings.nodeDetail.cloudRelayBindUnavailable") }}</p>
      <p v-if="result" class="settings-success">{{ t("settings.nodeDetail.cloudRelayBindDone", { handle: result.nodeHandle || "" }) }}</p>
      <p v-if="error" class="control-plane-error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Cloud } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { bindCloudRelayNode, controlPlaneQueryKeys, useCloudConnectivityQuery } from "../../../api/queries";
import type { Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ selectedNode: Node }>();
const { t } = useI18n();
const queryClient = useQueryClient();
const busy = ref(false);
const error = ref("");
const result = ref<{ nodeHandle?: string } | null>(null);
const connectivity = useCloudConnectivityQuery();
const available = computed(() => connectivity.data.value?.status === "active" && connectivity.data.value?.scopes.nodeRelay === true);

async function bind() {
  if (!available.value || busy.value) return;
  busy.value = true;
  error.value = "";
  result.value = null;
  try {
    result.value = await bindCloudRelayNode(props.selectedNode.id);
    showControlPlaneToast(t("settings.nodeDetail.cloudRelayBindDone", { handle: result.value?.nodeHandle || "" }), "success");
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
  } catch (failure) {
    error.value = `${t("settings.nodeDetail.cloudRelayBindFailed")} ${translateApiError(failure, t)}`;
  } finally {
    busy.value = false;
  }
}
</script>
