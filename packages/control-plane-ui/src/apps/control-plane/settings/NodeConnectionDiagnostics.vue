<template>
  <div class="node-connection-diagnostic-grid">
    <span><b>{{ t("settings.nodeDetail.connectionPingRtt") }}</b><em>{{ metricMs(diagnostics?.pingRttMs) }}</em></span>
    <span><b>{{ t("settings.nodeDetail.connectionPingP95") }}</b><em>{{ metricMs(diagnostics?.pingRttP95Ms) }}</em></span>
    <span><b>{{ t("settings.nodeDetail.connectionReconnects") }}</b><em>{{ metricValue(diagnostics?.consecutiveReconnects) }}</em></span>
    <span><b>{{ t("settings.nodeDetail.connectionNextRetry") }}</b><em>{{ retryCountdown(diagnostics?.nextRetryAt) }}</em></span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from "vue";
import { useI18n } from "vue-i18n";

type ConnectionDiagnostics = {
  status?: "connected" | "connecting" | "reconnecting" | "failed" | "disabled";
  pingRttMs?: number;
  pingRttP95Ms?: number;
  consecutiveReconnects?: number;
  nextRetryAt?: string;
};

const props = defineProps<{ diagnostics?: ConnectionDiagnostics }>();

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
