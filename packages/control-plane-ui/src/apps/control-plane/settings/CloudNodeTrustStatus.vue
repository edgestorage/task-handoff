<template>
  <section v-if="visible" class="cloud-node-trust" :data-state="trust?.state || phase" role="status">
    <header class="cloud-node-trust-head">
      <ShieldCheck :size="18" aria-hidden="true" />
      <div>
        <strong>{{ title }}</strong>
        <small>{{ nodeLabel }}</small>
      </div>
    </header>

    <template v-if="phase === 'waiting-node-trust' && trust">
      <p>{{ t("settings.nodeRelay.nodeTrust.waitingDescription") }}</p>
      <dl>
        <div><dt>{{ t("settings.nodeRelay.nodeTrust.controlPlane") }}</dt><dd>{{ trust.controlPlaneId }}</dd></div>
        <div><dt>{{ t("settings.nodeRelay.nodeTrust.reason") }}</dt><dd>{{ reasonLabel }}</dd></div>
        <div><dt>{{ t("settings.nodeRelay.nodeTrust.request") }}</dt><dd>{{ trust.requestId || "—" }}</dd></div>
        <div><dt>{{ t("settings.nodeRelay.nodeTrust.expires") }}</dt><dd>{{ formatTrustDate(trust.expiresAt) }}</dd></div>
      </dl>
      <div class="cloud-node-trust-identity">
        <span>{{ t("settings.nodeRelay.nodeTrust.fingerprint") }}</span>
        <code>{{ trust.controlPlaneFingerprint }}</code>
        <Button type="button" size="sm" variant="outline" @click="copy(trust.controlPlaneFingerprint)">
          <Copy :size="14" /><span>{{ copied === "fingerprint" ? t("settings.nodeRelay.copied") : t("settings.nodeRelay.nodeTrust.copyFingerprint") }}</span>
        </Button>
        <span>{{ t("settings.nodeRelay.nodeTrust.comparisonCode") }}</span>
        <code class="cloud-node-trust-comparison">{{ trust.comparisonCode }}</code>
        <Button type="button" size="sm" variant="outline" @click="copy(trust.comparisonCode)">
          <Copy :size="14" /><span>{{ copied === "code" ? t("settings.nodeRelay.copied") : t("settings.nodeRelay.nodeTrust.copyCode") }}</span>
        </Button>
      </div>
      <div class="cloud-node-trust-entrypoints">
        <p><strong>{{ t("settings.nodeRelay.nodeTrust.cliTitle") }}</strong> {{ t("settings.nodeRelay.nodeTrust.cliDescription") }}</p>
        <pre><code>{{ approveCommand }}</code></pre>
        <p><strong>{{ t("settings.nodeRelay.nodeTrust.connectedTitle") }}</strong> {{ t("settings.nodeRelay.nodeTrust.connectedDescription") }}</p>
      </div>
    </template>
    <template v-else>
      <p>{{ diagnostic }}</p>
      <pre v-if="recoveryCommand"><code>{{ recoveryCommand }}</code></pre>
    </template>

    <div class="cloud-node-trust-actions">
      <Button v-if="retryable" type="button" size="sm" variant="outline" @click="emit('retry')">
        <RefreshCw :size="14" /><span>{{ t("settings.nodeRelay.nodeTrust.checkAgain") }}</span>
      </Button>
      <Button v-if="terminal" type="button" size="sm" variant="outline" @click="emit('cancel')">{{ t("settings.nodeRelay.nodeTrust.cancelAdd") }}</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, RefreshCw, ShieldCheck } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import type { CloudNodeRelayTrust } from "../../../api/types";
import type { CloudNodeOnboardingPhase } from "./cloudNodeOnboardingAttempt";

const props = defineProps<{
  phase?: CloudNodeOnboardingPhase;
  trust?: CloudNodeRelayTrust;
  displayName?: string;
  nodeHandle?: string;
  error?: string;
}>();
const emit = defineEmits<{ cancel: []; retry: [] }>();
const { t, locale } = useI18n();
const copied = ref<"fingerprint" | "code">();
const formatTrustDate = (value?: string) => value ? formatDateTime(new Date(value), locale.value as SupportedLocale) : "—";

const visible = computed(() => Boolean(props.trust) || ["waiting-node-trust", "approved-connecting", "rejected", "expired", "failed"].includes(props.phase || ""));
const terminal = computed(() => ["rejected", "expired", "failed"].includes(props.phase || ""));
const retryable = computed(() => ["rejected", "expired", "failed"].includes(props.phase || ""));
const nodeLabel = computed(() => [props.displayName, props.nodeHandle].filter(Boolean).join(" · ") || t("settings.nodeRelay.nodeTrust.currentNode"));
const title = computed(() => t(`settings.nodeRelay.nodeTrust.phase.${props.phase || "waiting-node-trust"}`));
const reasonLabel = computed(() => t(`settings.nodeRelay.nodeTrust.reasons.${props.trust?.reason || "first-seen"}`));
const diagnostic = computed(() => props.error || t(`settings.nodeRelay.nodeTrust.phase.${props.phase || "failed"}Description`));
const approveCommand = computed(() => props.trust?.requestId
  ? `task-handoff-node-agent trust approve ${props.trust.requestId} --fingerprint ${props.trust.controlPlaneFingerprint}`
  : "task-handoff-node-agent trust list");
const recoveryCommand = computed(() => props.trust?.requestId
  ? `task-handoff-node-agent trust list --json`
  : undefined);

async function copy(value: string) {
  if (!navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(value);
  copied.value = value === props.trust?.controlPlaneFingerprint ? "fingerprint" : "code";
}
</script>

<style scoped>
.cloud-node-trust { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-raised); }
.cloud-node-trust[data-state="rejected"], .cloud-node-trust[data-state="expired"], .cloud-node-trust[data-state="failed"] { border-color: var(--status-warning); }
.cloud-node-trust-head { display: flex; align-items: flex-start; gap: 9px; color: var(--text-strong); }
.cloud-node-trust-head > div { display: grid; gap: 2px; min-width: 0; }
.cloud-node-trust-head strong { font-size: 13px; font-weight: 500; }
.cloud-node-trust-head small, .cloud-node-trust p, .cloud-node-trust dt, .cloud-node-trust dd { font-size: 12px; line-height: 1.45; }
.cloud-node-trust-head small, .cloud-node-trust dt { color: var(--text-muted); }
.cloud-node-trust p { margin: 0; color: var(--text-muted); }
.cloud-node-trust dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 14px; margin: 0; }
.cloud-node-trust dl > div { display: grid; gap: 1px; min-width: 0; }
.cloud-node-trust dd { margin: 0; color: var(--text-strong); overflow-wrap: anywhere; }
.cloud-node-trust-identity { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; align-items: center; }
.cloud-node-trust-identity > span { color: var(--text-muted); font-size: 12px; }
.cloud-node-trust-identity code, .cloud-node-trust pre code { overflow-wrap: anywhere; font-size: 12px; }
.cloud-node-trust-comparison { color: var(--text-strong); font-weight: 500; letter-spacing: 0.04em; }
.cloud-node-trust-entrypoints { display: grid; gap: 6px; }
.cloud-node-trust-entrypoints strong { color: var(--text-strong); font-weight: 500; }
.cloud-node-trust pre { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--surface-hover); white-space: pre-wrap; }
.cloud-node-trust-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 560px) { .cloud-node-trust dl { grid-template-columns: minmax(0, 1fr); } }
</style>
