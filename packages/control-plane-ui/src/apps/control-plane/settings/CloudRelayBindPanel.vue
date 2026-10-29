<template>
  <section class="cloud-relay-panel" :class="{ 'cloud-relay-panel-embedded': embedded }">
    <header class="cloud-relay-panel-head">
      <span>{{ t("settings.nodeDetail.cloudRelayBindTitle") }}</span>
      <Badge v-if="linkedHandle" variant="secondary" class="cloud-relay-panel-status">
        <Check :size="14" aria-hidden="true" />
        {{ t("settings.cloud.nodeAdded") }}
      </Badge>
      <Button v-else variant="outline" size="sm" :disabled="busy || account.isLoading.value || connectivity.isLoading.value" @click="primaryAction">
        <Cloud :size="14" aria-hidden="true" />
        <span>{{ primaryActionLabel }}</span>
      </Button>
    </header>
    <div class="cloud-relay-panel-body">
      <template v-if="linkedHandle">
        <dl class="cloud-relay-panel-identity">
          <dt>{{ t("settings.nodeDetail.cloudRelayNodeHandle") }}</dt>
          <dd><code>{{ linkedHandle }}</code></dd>
        </dl>
        <p class="cloud-relay-panel-hint">{{ t("settings.nodeDetail.cloudRelayBindLinkedHint") }}</p>
      </template>
      <p v-else class="cloud-relay-panel-hint">{{ available ? t("settings.nodeDetail.cloudRelayBindHint") : unavailableReason }}</p>
      <p v-if="error" class="cloud-relay-panel-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Check, Cloud } from "@lucide/vue";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL } from "@task-handoff/protocol/control-plane";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { bindCloudRelayNode, controlPlaneQueryKeys, useCloudAccountQuery, useCloudConnectivityQuery } from "../../../api/queries";
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
  && connectivity.data.value?.status === "active");
const primaryActionLabel = computed(() => {
  if (busy.value) return t("settings.nodeDetail.cloudRelayBindBusy");
  if (account.isLoading.value || connectivity.isLoading.value) return t("settings.nodeDetail.cloudRelayBindLoading");
  if (available.value) return t("settings.nodeDetail.cloudRelayBindAction");
  if (!account.data.value?.signedIn) return t("settings.nodeDetail.cloudRelayBindSignInAction");
  return t("settings.nodeDetail.cloudRelayBindSetupAction");
});
const unavailableReason = computed(() => !account.data.value?.signedIn
  ? t("settings.nodeDetail.cloudRelayBindRequiresSignIn")
  : t("settings.nodeDetail.cloudRelayBindRequiresBinding"));

async function primaryAction() {
  if (busy.value || account.isLoading.value || connectivity.isLoading.value) return;
  if (available.value) {
    await bind();
    return;
  }
  emit("open-cloud-settings");
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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--line);
  padding: 8px 12px;
}

.cloud-relay-panel-head > span {
  min-width: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cloud-relay-panel-head > :deep(button),
.cloud-relay-panel-status {
  flex-shrink: 0;
}

.cloud-relay-panel-status {
  color: var(--status-success);
  font-weight: 400;
}

.cloud-relay-panel-body {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
}

.cloud-relay-panel-hint,
.cloud-relay-panel-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cloud-relay-panel-hint { color: var(--text-muted); }
.cloud-relay-panel-error { color: var(--status-danger); }

.cloud-relay-panel-identity {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.cloud-relay-panel-identity dt { color: var(--text-muted); }
.cloud-relay-panel-identity dd { min-width: 0; margin: 0; color: var(--text-strong); overflow-wrap: anywhere; }
.cloud-relay-panel-identity code { font-size: inherit; }
</style>
