<template>
  <div class="node-connection-diagnostics">
    <div v-if="eventTransport" class="node-event-transport" :data-status="eventTransport.status">
      <div class="node-event-transport-title">
        <b>{{ t("settings.nodeDetail.eventUplink") }}</b>
        <em>{{ eventTransportStatus }}</em>
      </div>
      <p v-if="eventTransport.status !== 'healthy'">{{ eventTransportMessage }}</p>
      <div class="node-event-transport-metrics">
        <span><b>{{ t("settings.nodeDetail.eventBuffered") }}</b><em>{{ formatBytes(eventTransport.bufferedBytes) }}</em></span>
        <span><b>{{ t("settings.nodeDetail.eventPeakBuffered") }}</b><em>{{ formatBytes(eventTransport.peakBufferedBytes) }}</em></span>
        <span><b>{{ t("settings.nodeDetail.eventCoalesced") }}</b><em>{{ eventTransport.coalescedEvents }}</em></span>
        <span v-if="eventTransport.oversizedEvents"><b>{{ t("settings.nodeDetail.eventOversized") }}</b><em>{{ eventTransport.oversizedEvents }}</em></span>
        <span v-if="eventTransport.peakEventBytes"><b>{{ t("settings.nodeDetail.eventPeakPayload") }}</b><em>{{ formatBytes(eventTransport.peakEventBytes) }}</em></span>
      </div>
    </div>
    <div class="node-connection-diagnostic-grid">
      <span><b>{{ t("settings.nodeDetail.connectionPingRtt") }}</b><em>{{ metricMs(diagnostics?.pingRttMs) }}</em></span>
      <span><b>{{ t("settings.nodeDetail.connectionPingP95") }}</b><em>{{ metricMs(diagnostics?.pingRttP95Ms) }}</em></span>
      <span><b>{{ t("settings.nodeDetail.connectionReconnects") }}</b><em>{{ metricValue(diagnostics?.consecutiveReconnects) }}</em></span>
      <span><b>{{ t("settings.nodeDetail.connectionNextRetry") }}</b><em>{{ retryCountdown(diagnostics?.nextRetryAt) }}</em></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { NodeAgentEventTransportHealth } from "../../../api/types";

type ConnectionDiagnostics = {
  status?: "connected" | "connecting" | "reconnecting" | "failed" | "disabled";
  pingRttMs?: number;
  pingRttP95Ms?: number;
  consecutiveReconnects?: number;
  nextRetryAt?: string;
};

const props = defineProps<{ diagnostics?: ConnectionDiagnostics; eventTransport?: NodeAgentEventTransportHealth }>();

const { t } = useI18n();
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

const metricMs = (value?: number) => value === undefined
  ? t(props.diagnostics?.status === "connected"
    ? "settings.nodeDetail.connectionWaitingFirstSample"
    : "common.status.unavailable")
  : t("settings.nodeDetail.connectionMilliseconds", { value: Math.round(value) });
const metricValue = (value?: number) => value === undefined ? t("common.status.unavailable") : value;
const retryCountdown = (value?: string) => {
  if (!value) return t("settings.nodeDetail.connectionRetryNotScheduled");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("common.status.unavailable");
  const remainingSeconds = Math.max(0, Math.ceil((timestamp - clock.value) / 1_000));
  return remainingSeconds > 0
    ? t("settings.nodeDetail.connectionRetryIn", { seconds: remainingSeconds })
    : t("settings.nodeDetail.connectionRetryNow");
};
const eventTransportStatus = computed(() => t(`settings.nodeDetail.eventTransportStatus.${props.eventTransport?.status || "healthy"}`));
const eventTransportMessage = computed(() => t(props.eventTransport?.oversizedEvents
  ? "settings.nodeDetail.eventTransportPayloadExceeded"
  : props.eventTransport?.status === "congested"
    ? "settings.nodeDetail.eventTransportCongested"
    : "settings.nodeDetail.eventTransportRecovering"));
const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

onMounted(() => {
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 1_000);
});

onScopeDispose(() => {
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<style scoped>
.node-connection-diagnostics {
  display: grid;
  gap: 10px;
}

.node-event-transport {
  display: grid;
  gap: 7px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.node-event-transport-title,
.node-event-transport-metrics span {
  display: grid;
  grid-template-columns: minmax(88px, 1fr) auto;
  align-items: baseline;
  gap: 14px;
}

.node-event-transport-title b,
.node-event-transport-title em,
.node-event-transport-metrics b,
.node-event-transport-metrics em {
  font-size: 12px;
  font-style: normal;
  line-height: 1.35;
}

.node-event-transport-title b,
.node-event-transport-metrics b {
  color: var(--text-muted);
  font-weight: 650;
}

.node-event-transport-title em,
.node-event-transport-metrics em {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.node-event-transport[data-status="congested"] .node-event-transport-title em,
.node-event-transport[data-status="recovering"] .node-event-transport-title em {
  color: var(--warning, var(--text-muted));
}

.node-event-transport p {
  max-width: 340px;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.node-event-transport-metrics {
  display: grid;
  gap: 5px;
}

.node-connection-diagnostic-grid {
  display: grid;
  gap: 7px;
}

.node-connection-diagnostic-grid span {
  display: grid;
  grid-template-columns: minmax(88px, 1fr) auto;
  align-items: baseline;
  gap: 14px;
}

.node-connection-diagnostic-grid b,
.node-connection-diagnostic-grid em {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-style: normal;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-connection-diagnostic-grid b {
  color: var(--text-muted);
  font-weight: 650;
}

.node-connection-diagnostic-grid em {
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}
</style>
