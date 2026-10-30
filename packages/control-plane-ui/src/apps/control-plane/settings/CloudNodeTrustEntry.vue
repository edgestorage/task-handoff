<template>
  <Button type="button" variant="ghost" class="cloud-node-trust-entry" :class="{ active }" @click="emit('select', trust.nodeHandle)">
    <span class="cloud-node-trust-entry-dot" aria-hidden="true" />
    <span class="cloud-node-trust-entry-copy">
      <strong>{{ displayName || trust.displayName || t("settings.nodeRelay.unnamedNode") }}</strong>
      <span>{{ t(`settings.nodeRelay.nodeTrust.status.${trust.state}`) }}</span>
    </span>
    <ChevronRight :size="16" aria-hidden="true" />
  </Button>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import type { CloudNodeRelayTrust } from "../../../api/types";

defineProps<{ trust: CloudNodeRelayTrust; displayName?: string; active?: boolean }>();
const emit = defineEmits<{ select: [nodeHandle: string] }>();
const { t } = useI18n();
</script>

<style scoped>
.cloud-node-trust-entry { display: grid; grid-template-columns: 12px minmax(0, 1fr) 16px; gap: 9px; width: 100%; height: auto; min-height: 58px; padding: 10px 12px; border-radius: 0; text-align: left; font-weight: 400; }
.cloud-node-trust-entry.active { background: var(--surface-active); box-shadow: inset 3px 0 0 var(--brand-accent); }
.cloud-node-trust-entry-dot { width: 9px; height: 9px; border-radius: 999px; background: var(--status-warning); box-shadow: 0 0 0 3px var(--status-warning-bg); }
.cloud-node-trust-entry-copy { display: grid; gap: 3px; min-width: 0; }
.cloud-node-trust-entry-copy strong { overflow: hidden; color: var(--text-strong); font-size: 13px; font-weight: 500; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.cloud-node-trust-entry-copy > span { color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 1.4; }
.cloud-node-trust-entry > svg { color: var(--text-muted); }
</style>
