<template>
  <section class="proxy-node-panel">
    <div class="proxy-trust-warning">
      <ShieldAlert :size="18" />
      <span>{{ t("settings.controlPlaneProxy.trustWarning") }}</span>
    </div>

    <div class="proxy-path" :aria-label="t('settings.controlPlaneProxy.path')">
      <div class="proxy-hop">
        <small>{{ t("settings.controlPlaneProxy.source") }}</small>
        <strong>{{ t("settings.controlPlaneProxy.thisControlPlane") }}</strong>
        <Badge variant="secondary">{{ stateLabel(pathState.source) }}</Badge>
      </div>
      <ArrowRight class="proxy-arrow" :size="18" />
      <div class="proxy-hop">
        <small>{{ t("settings.controlPlaneProxy.proxy") }}</small>
        <strong>{{ proxyPath?.proxyId || t("settings.controlPlaneProxy.unknown") }}</strong>
        <Badge :variant="pathState.proxy === 'unreachable' ? 'destructive' : 'secondary'">{{ stateLabel(pathState.proxy) }}</Badge>
        <span class="proxy-binding-status">{{ t("settings.controlPlaneProxy.binding") }} · {{ stateLabel(pathState.binding) }}</span>
      </div>
      <ArrowRight class="proxy-arrow" :size="18" />
      <div class="proxy-hop">
        <small>{{ t("settings.controlPlaneProxy.target") }}</small>
        <strong>{{ pathState.target?.name || proxyPath?.targetNodeId || selectedNode.name }}</strong>
        <Badge :variant="pathState.target?.status === 'online' ? 'default' : 'secondary'">{{ stateLabel(pathState.target?.status || 'unknown') }}</Badge>
        <span class="proxy-binding-status">{{ t("settings.controlPlaneProxy.health") }} · {{ stateLabel(pathState.target?.health || 'unknown') }}</span>
      </div>
    </div>

    <dl class="proxy-identifiers">
      <dt>{{ t("settings.controlPlaneProxy.binding") }}</dt>
      <dd>{{ proxyPath?.proxyBindingId || t("settings.controlPlaneProxy.unknown") }}</dd>
      <dt>{{ t("settings.controlPlaneProxy.revisions") }}</dt>
      <dd>{{ pathState.bindingRevision ?? t("settings.controlPlaneProxy.unknown") }} / {{ pathState.revision ?? t("settings.controlPlaneProxy.unknown") }}</dd>
      <dt>{{ t("settings.controlPlaneProxy.observedAt") }}</dt>
      <dd>{{ pathState.observedAt || t("settings.controlPlaneProxy.unknown") }}</dd>
    </dl>

    <div v-if="pathState.reason" class="proxy-reason" role="status">
      <strong>{{ pathState.reason.code }}</strong>
      <span>{{ pathState.reason.message }}</span>
      <code>{{ pathState.reason.retryable ? t("settings.controlPlaneProxy.retryable") : t("settings.controlPlaneProxy.notRetryable") }}</code>
    </div>
    <p v-else class="proxy-empty">{{ t("settings.controlPlaneProxy.noStructuredError") }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRight, ShieldAlert } from "@lucide/vue";
import type { Node } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { proxyPathState } from "./controlPlaneProxyUi";

const props = defineProps<{ selectedNode: Node }>();
const { t } = useI18n();
const proxyPath = computed(() => props.selectedNode.connectionPath?.kind === "control-plane-proxy" ? props.selectedNode.connectionPath : undefined);
const pathState = computed(() => proxyPathState(props.selectedNode));
const stateLabel = (state: string) => t(`settings.controlPlaneProxy.state.${state}`);
</script>

<style scoped>
.proxy-node-panel { display: grid; gap: 14px; }
.proxy-trust-warning { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--warning-border, var(--border)); border-radius: 6px; background: var(--surface-inset); font-size: 12px; line-height: 1.5; }
.proxy-trust-warning svg { flex: none; color: var(--warning, var(--text-muted)); }
.proxy-path { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 8px; }
.proxy-hop { display: grid; gap: 5px; min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; }
.proxy-hop small { color: var(--text-muted); font-size: 12px; }
.proxy-hop strong { overflow-wrap: anywhere; font-size: 12px; }
.proxy-binding-status { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.proxy-hop :deep(.badge) { justify-self: start; }
.proxy-arrow { color: var(--text-muted); }
.proxy-identifiers { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 12px; margin: 0; font-size: 12px; }
.proxy-identifiers dt { color: var(--text-muted); }
.proxy-identifiers dd { margin: 0; overflow-wrap: anywhere; font-family: var(--font-mono); }
.proxy-reason { display: grid; gap: 4px; padding: 10px 12px; border-left: 3px solid var(--destructive); background: var(--surface-inset); font-size: 12px; }
.proxy-reason strong, .proxy-reason code { overflow-wrap: anywhere; }
.proxy-empty { margin: 0; color: var(--text-muted); font-size: 12px; }
@media (max-width: 720px) { .proxy-path { grid-template-columns: 1fr; } .proxy-arrow { transform: rotate(90deg); justify-self: center; } }
</style>
