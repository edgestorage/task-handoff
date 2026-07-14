<template>
  <div class="automation-status">
    <Badge :variant="status.data.value?.ready ? 'default' : 'secondary'">{{ statusLabel }}</Badge>
    <span>{{ details }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppAutomationStatusQuery } from "../../api/queries";
import type { AppSession } from "../../api/types";
import { Badge } from "../../components/ui/badge";

const props = defineProps<{
  session: AppSession;
}>();

const status = useAppAutomationStatusQuery(props.session.id, props.session.status === "running" && Boolean(props.session.automation));

const statusLabel = computed(() => {
  if (status.isLoading.value) {
    return "checking";
  }
  if (status.data.value?.ready) {
    return "ready";
  }
  return "not ready";
});

const details = computed(() => {
  const data = status.data.value;
  if (!data) {
    return props.session.automation?.endpoint || "";
  }
  if (data.ready) {
    return [data.browser, data.protocolVersion ? `protocol ${data.protocolVersion}` : undefined].filter(Boolean).join(" · ");
  }
  return data.error?.message || data.endpoint;
});
</script>

<style src="../../styles/features/apps/automation-status.css"></style>
