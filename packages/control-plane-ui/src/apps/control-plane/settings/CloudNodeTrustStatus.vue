<template>
  <section v-if="visible" class="cloud-node-trust" :data-state="trust?.state || phase">
    <header class="cloud-node-trust-head" role="status">
      <LoaderCircle v-if="phase === 'submitting'" class="cloud-node-trust-spinner" :size="18" aria-hidden="true" />
      <ShieldCheck v-else :size="18" aria-hidden="true" />
      <div>
        <strong>{{ title }}</strong>
        <small v-if="!hideNodeLabel">{{ nodeLabel }}</small>
      </div>
    </header>

    <template v-if="phase === 'waiting-node-trust' && trust">
      <p>{{ t("settings.nodeRelay.nodeTrust.chooseMethodHint") }}</p>
      <div class="cloud-node-trust-verification">
        <div class="cloud-node-trust-code-row">
          <div>
            <span>{{ t("settings.nodeRelay.nodeTrust.comparisonCode") }}</span>
            <code class="cloud-node-trust-comparison">{{ trust.comparisonCode }}</code>
          </div>
          <Button type="button" size="sm" variant="outline" @click="copy(trust.comparisonCode, 'code')">
            <Copy :size="14" aria-hidden="true" /><span aria-live="polite">{{ copied === "code" ? t("settings.nodeRelay.nodeTrust.copyDone") : t("settings.nodeRelay.nodeTrust.copyCode") }}</span>
          </Button>
        </div>
        <p>{{ t("settings.nodeRelay.nodeTrust.expiresAt", { time: formatTrustDate(trust.expiresAt) }) }}</p>
      </div>
      <Tabs v-model="method">
        <TabsList class="cloud-node-trust-tabs" :aria-label="t('settings.nodeRelay.nodeTrust.methodGroupLabel')">
          <TabsTrigger value="control-plane">
            <MonitorSmartphone :size="14" aria-hidden="true" /><span>{{ t("settings.nodeRelay.nodeTrust.controlPlaneMethod.action") }}</span>
          </TabsTrigger>
          <TabsTrigger value="cli">
            <Terminal :size="14" aria-hidden="true" /><span>{{ t("settings.nodeRelay.nodeTrust.cliMethod.action") }}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div v-if="method === 'control-plane'" class="cloud-node-trust-pane">
        <p>{{ t("settings.nodeRelay.nodeTrust.controlPlaneMethod.description") }}</p>
        <ol class="cloud-node-trust-steps">
          <li>{{ t("settings.nodeRelay.nodeTrust.controlPlaneMethod.step1") }}</li>
          <li>{{ t("settings.nodeRelay.nodeTrust.controlPlaneMethod.step2") }}</li>
          <li>{{ t("settings.nodeRelay.nodeTrust.controlPlaneMethod.step3") }}</li>
        </ol>
      </div>
      <div v-else class="cloud-node-trust-pane">
        <p>{{ t("settings.nodeRelay.nodeTrust.cliMethod.description") }}</p>
        <div class="cloud-node-trust-cli-head">
          <span class="cloud-node-trust-cli-label">{{ t("settings.nodeRelay.nodeTrust.cliMethod.commandLabel") }}</span>
          <Button type="button" size="sm" variant="outline" @click="copy(approveCommand, 'command')">
            <Copy :size="14" aria-hidden="true" /><span aria-live="polite">{{ copied === "command" ? t("settings.nodeRelay.nodeTrust.copyDone") : t("settings.nodeRelay.nodeTrust.copyCommand") }}</span>
          </Button>
        </div>
        <ScrollArea class="cloud-node-trust-command">
          <pre tabindex="0"><code>{{ approveCommand }}</code></pre>
        </ScrollArea>
      </div>
      <p v-if="trust.reason !== 'first-seen'" class="cloud-node-trust-diagnostic">{{ reasonLabel }}</p>
      <p v-if="error" class="cloud-node-trust-diagnostic">{{ error }}</p>
    </template>
    <p v-else>{{ diagnostic }}</p>

    <Collapsible v-if="trust" v-model:open="detailsOpen" class="cloud-node-trust-disclosure">
      <div class="cloud-node-trust-tools">
        <CollapsibleTrigger as-child>
          <Button type="button" size="sm" variant="ghost">
            <span>{{ t(detailsOpen ? "settings.nodeRelay.nodeTrust.hideDetails" : "settings.nodeRelay.nodeTrust.showDetails") }}</span>
            <ChevronDown :size="14" :class="{ 'cloud-node-trust-chevron-open': detailsOpen }" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div class="cloud-node-trust-details">
          <dl>
            <div><dt>{{ t("settings.nodeRelay.nodeTrust.controlPlane") }}</dt><dd>{{ trust.controlPlaneId }}</dd></div>
            <div><dt>{{ t("settings.nodeRelay.nodeTrust.reason") }}</dt><dd>{{ reasonLabel }}</dd></div>
            <div><dt>{{ t("settings.nodeRelay.nodeTrust.request") }}</dt><dd>{{ trust.requestId || "—" }}</dd></div>
            <div><dt>{{ t("settings.nodeRelay.nodeTrust.nodeHandle") }}</dt><dd>{{ nodeHandle || trust.nodeHandle }}</dd></div>
          </dl>
          <div class="cloud-node-trust-identity-item">
            <span>{{ t("settings.nodeRelay.nodeTrust.fingerprint") }}</span>
            <code>{{ trust.controlPlaneFingerprint }}</code>
            <Button type="button" size="sm" variant="outline" @click="copy(trust.controlPlaneFingerprint, 'fingerprint')">
              <Copy :size="14" aria-hidden="true" /><span aria-live="polite">{{ copied === "fingerprint" ? t("settings.nodeRelay.nodeTrust.copyDone") : t("settings.nodeRelay.nodeTrust.copyFingerprint") }}</span>
            </Button>
          </div>
          <pre v-if="phase !== 'waiting-node-trust' && recoveryCommand"><code>{{ recoveryCommand }}</code></pre>
        </div>
      </CollapsibleContent>
    </Collapsible>

    <div v-if="!hideActions && (retryable || terminal || canCancel)" class="cloud-node-trust-actions">
      <Button v-if="canReapply" type="button" size="sm" variant="outline" @click="emit('reapply')">
        <RefreshCw :size="14" aria-hidden="true" /><span>{{ t("settings.nodeRelay.nodeTrust.reapply") }}</span>
      </Button>
      <Button v-if="retryable" type="button" size="sm" variant="outline" @click="emit('retry')">
        <RefreshCw :size="14" aria-hidden="true" /><span>{{ t("settings.nodeRelay.nodeTrust.retryConnection") }}</span>
      </Button>
      <Button v-if="canCancel" type="button" size="sm" variant="outline" @click="emit('cancel')">{{ t("settings.nodeRelay.nodeTrust.cancelAdd") }}</Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Copy, LoaderCircle, MonitorSmartphone, RefreshCw, ShieldCheck, Terminal } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import type { CloudNodeRelayTrust } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import type { CloudNodeOnboardingPhase } from "./cloudNodeOnboardingAttempt";

const props = defineProps<{
  phase?: CloudNodeOnboardingPhase;
  trust?: CloudNodeRelayTrust;
  displayName?: string;
  nodeHandle?: string;
  error?: string;
  hideActions?: boolean;
  hideNodeLabel?: boolean;
}>();
const emit = defineEmits<{ cancel: []; retry: []; reapply: [] }>();
const { t, locale } = useI18n();
type CopyTarget = "fingerprint" | "code" | "command";
type ApprovalMethod = "control-plane" | "cli";
const copied = ref<CopyTarget>();
const detailsOpen = ref(false);
const method = ref<ApprovalMethod>("control-plane");
const formatTrustDate = (value?: string) => value ? formatDateTime(new Date(value), locale.value as SupportedLocale) : "—";

const visible = computed(() => Boolean(props.trust) || ["submitting", "waiting-node-trust", "approved-connecting", "rejected", "expired", "failed"].includes(props.phase || ""));
const terminal = computed(() => ["rejected", "expired", "failed"].includes(props.phase || ""));
const retryable = computed(() => props.phase === "failed");
const canCancel = computed(() => props.phase !== "complete");
const canReapply = computed(() => props.phase === "rejected" || props.phase === "expired");
const nodeLabel = computed(() => props.displayName || t("settings.nodeRelay.nodeTrust.currentNode"));
const title = computed(() => t(`settings.nodeRelay.nodeTrust.phase.${props.phase || "waiting-node-trust"}`));
const reasonLabel = computed(() => t(`settings.nodeRelay.nodeTrust.reasons.${props.trust?.reason || "first-seen"}`));
const diagnostic = computed(() => {
  const description = t(`settings.nodeRelay.nodeTrust.phase.${props.phase || "failed"}Description`);
  // A rejected request with no current trust projection can carry the reason
  // the retry itself was refused. Ordinary authoritative rejections have no
  // error and still show their phase description.
  return props.error || description;
});
const approveCommand = computed(() => props.trust?.requestId
  ? `task-handoff-node-agent trust approve ${props.trust.requestId} --fingerprint ${props.trust.controlPlaneFingerprint}`
  : "task-handoff-node-agent trust list");
const recoveryCommand = computed(() => props.trust?.requestId ? "task-handoff-node-agent trust list --json" : undefined);

// Watch a primitive key instead of an array. Every authoritative snapshot
// replaces the trust object, so an array getter would fire on every refresh
// and reset the selected approval method while the request stays the same.
const requestKey = computed(() => [props.trust?.requestId, props.trust?.controlPlaneFingerprint, props.nodeHandle, props.phase].join("\u0000"));
watch(requestKey, () => {
  copied.value = undefined;
  detailsOpen.value = false;
  method.value = "control-plane";
});

async function copy(value: string, target: CopyTarget) {
  copied.value = undefined;
  if (!navigator.clipboard?.writeText) {
    showControlPlaneToast(t("settings.nodeRelay.nodeTrust.copyFailed"), "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    copied.value = target;
  } catch {
    showControlPlaneToast(t("settings.nodeRelay.nodeTrust.copyFailed"), "error");
  }
}
</script>

<style scoped>
.cloud-node-trust { display: grid; gap: 12px; min-width: 0; padding: 16px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-raised); }
.cloud-node-trust[data-state="rejected"], .cloud-node-trust[data-state="expired"], .cloud-node-trust[data-state="failed"] { border-color: var(--status-warning); }
.cloud-node-trust-head { display: flex; align-items: flex-start; gap: 9px; color: var(--text-strong); }
.cloud-node-trust-head > svg { flex: 0 0 auto; margin-top: 1px; }
.cloud-node-trust-spinner { animation: cloud-node-trust-spin 0.8s linear infinite; }
@keyframes cloud-node-trust-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cloud-node-trust-spinner { animation: none; } }
.cloud-node-trust-head > div { display: grid; gap: 3px; min-width: 0; }
.cloud-node-trust-head strong { font-size: 14px; font-weight: 500; line-height: 1.4; }
.cloud-node-trust-head small, .cloud-node-trust p, .cloud-node-trust dt, .cloud-node-trust dd { font-size: 12px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
.cloud-node-trust-head small, .cloud-node-trust dt { color: var(--text-muted); }
.cloud-node-trust p { margin: 0; color: var(--text-muted); }
.cloud-node-trust-verification { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); }
.cloud-node-trust-code-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.cloud-node-trust-code-row > div { display: grid; gap: 5px; min-width: 0; }
.cloud-node-trust-code-row span, .cloud-node-trust-identity-item > span { color: var(--text-muted); font-size: 12px; }
.cloud-node-trust-comparison { color: var(--text-strong); font-size: 16px; font-weight: 500; line-height: 1.5; letter-spacing: 0.04em; overflow-wrap: anywhere; }
.cloud-node-trust-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; height: 32px; min-height: 32px; gap: 1px; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-inset); }
.cloud-node-trust-tabs :deep(button) { display: inline-flex; align-items: center; justify-content: center; height: 26px; min-height: 26px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; }
.cloud-node-trust-tabs :deep(button > span) { display: inline-flex; align-items: center; gap: 6px; }
.cloud-node-trust-tabs :deep(svg) { flex: 0 0 auto; }
.cloud-node-trust-tabs :deep(button:hover),
.cloud-node-trust-tabs :deep(button:focus-visible),
.cloud-node-trust-tabs :deep(button[data-state="active"]) { background: var(--surface-active); color: var(--text-strong); box-shadow: none; outline: none; }
.cloud-node-trust-pane { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); }
.cloud-node-trust-steps { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 1.5; }
.cloud-node-trust-steps li::marker { color: var(--text-subtle); }
.cloud-node-trust-cli-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.cloud-node-trust-cli-head :deep(svg) { flex: 0 0 auto; }
.cloud-node-trust-cli-label { color: var(--text-muted); font-size: 12px; }
.cloud-node-trust-command { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-hover); }
.cloud-node-trust-command :deep(pre) { width: max-content; min-width: 100%; padding-bottom: 18px; background: transparent; white-space: pre; }
.cloud-node-trust-disclosure, .cloud-node-trust-details { min-width: 0; }
.cloud-node-trust-tools, .cloud-node-trust-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.cloud-node-trust-tools :deep(svg) { flex: 0 0 auto; }
.cloud-node-trust-chevron-open { transform: rotate(180deg); }
.cloud-node-trust-details { display: grid; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.cloud-node-trust dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
.cloud-node-trust dl > div { display: grid; gap: 2px; min-width: 0; }
.cloud-node-trust dd { margin: 0; color: var(--text-strong); }
.cloud-node-trust-identity-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; min-width: 0; }
.cloud-node-trust-identity-item > span { grid-column: 1 / -1; }
.cloud-node-trust-identity-item > code { min-width: 0; }
.cloud-node-trust-identity-item code, .cloud-node-trust pre code { overflow-wrap: anywhere; font-size: 12px; }
.cloud-node-trust p.cloud-node-trust-diagnostic { color: var(--status-warning); }
.cloud-node-trust pre { min-width: 0; margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--surface-hover); white-space: pre-wrap; }
@media (max-width: 560px) {
  .cloud-node-trust { padding: 12px; }
  .cloud-node-trust dl, .cloud-node-trust-identity-item { grid-template-columns: minmax(0, 1fr); }
  .cloud-node-trust-identity-item > :deep(button) { justify-self: start; }
}
</style>
