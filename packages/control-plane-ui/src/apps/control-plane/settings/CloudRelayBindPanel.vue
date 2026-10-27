<template>
  <section class="cloud-relay-panel" :class="{ 'cloud-relay-panel-embedded': embedded }">
    <header class="cloud-relay-panel-head">
      <span>{{ t("settings.nodeDetail.cloudRelayBindTitle") }}</span>
      <Button variant="outline" size="sm" :disabled="busy || Boolean(linkedHandle) || account.isLoading.value || connectivity.isLoading.value" @click="primaryAction">
        <Cloud :size="14" />
        <span>{{ linkedHandle ? t("settings.cloud.nodeAdded") : primaryActionLabel }}</span>
      </Button>
    </header>
    <div class="cloud-relay-panel-body">
      <p class="cloud-relay-panel-hint">{{ available ? t("settings.nodeDetail.cloudRelayBindHint") : unavailableReason }}</p>
      <p v-if="linkedHandle" class="cloud-relay-panel-result">{{ t("settings.nodeDetail.cloudRelayBindDone", { handle: linkedHandle }) }}</p>
      <p v-if="error" class="cloud-relay-panel-error">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Cloud } from "@lucide/vue";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL } from "@task-handoff/protocol/control-plane";
import { Button } from "../../../components/ui/button";
import { bindCloudRelayNode, controlPlaneQueryKeys, updateCloudScopes, useCloudAccountQuery, useCloudConnectivityQuery } from "../../../api/queries";
import type { Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ selectedNode: Node; embedded?: boolean }>();
const emit = defineEmits<{ "open-cloud-settings": [] }>();
const { t } = useI18n();
const queryClient = useQueryClient();
const busy = ref(false);
const error = ref("");
const result = ref<{ nodeHandle?: string } | null>(null);
const linkedHandle = computed(() => props.selectedNode.labels[CLOUD_ACCOUNT_NODE_HANDLE_LABEL] || result.value?.nodeHandle || "");
const account = useCloudAccountQuery();
const connectivity = useCloudConnectivityQuery();
const available = computed(() => Boolean(account.data.value?.signedIn)
  && connectivity.data.value?.status === "active"
  && connectivity.data.value?.scopes.nodeRelay === true);
const scopeBlocked = computed(() => Boolean(account.data.value?.signedIn)
  && connectivity.data.value?.status === "active"
  && connectivity.data.value?.scopes.nodeRelay === false);
const primaryActionLabel = computed(() => {
  if (busy.value) return scopeBlocked.value && !available.value
    ? t("settings.nodeDetail.cloudRelayBindEnablingScope")
    : t("settings.nodeDetail.cloudRelayBindBusy");
  if (account.isLoading.value || connectivity.isLoading.value) return t("settings.nodeDetail.cloudRelayBindLoading");
  if (available.value) return t("settings.nodeDetail.cloudRelayBindAction");
  if (!account.data.value?.signedIn) return t("settings.nodeDetail.cloudRelayBindSignInAction");
  if (connectivity.data.value?.status !== "active") return t("settings.nodeDetail.cloudRelayBindSetupAction");
  return t("settings.nodeDetail.cloudRelayBindEnableScopeAction");
});
const unavailableReason = computed(() => !account.data.value?.signedIn
  ? t("settings.nodeDetail.cloudRelayBindRequiresSignIn")
  : connectivity.data.value?.status !== "active"
    ? t("settings.nodeDetail.cloudRelayBindRequiresBinding")
    : t("settings.nodeDetail.cloudRelayBindRequiresScope"));

async function primaryAction() {
  if (busy.value || account.isLoading.value || connectivity.isLoading.value) return;
  if (available.value) {
    await bind();
    return;
  }
  if (!scopeBlocked.value) {
    emit("open-cloud-settings");
    return;
  }
  await enableNodeRelay();
}

async function enableNodeRelay() {
  if (busy.value || !connectivity.data.value) return;
  busy.value = true;
  error.value = "";
  result.value = null;
  try {
    await updateCloudScopes({ ...connectivity.data.value.scopes, nodeRelay: true });
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.cloudConnectivity });
  } catch (failure) {
    error.value = `${t("settings.nodeDetail.cloudRelayBindEnableScopeFailed")} ${translateApiError(failure, t)}`;
  } finally {
    busy.value = false;
  }
}

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

.cloud-relay-panel-body {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.cloud-relay-panel-hint,
.cloud-relay-panel-result,
.cloud-relay-panel-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.cloud-relay-panel-hint { color: var(--text-muted); }
.cloud-relay-panel-result { color: var(--status-success); }
.cloud-relay-panel-error { color: var(--status-danger); }

@media (max-width: 720px) {
  .cloud-relay-panel-head { align-items: flex-start; flex-direction: column; }
}
</style>
