<template>
  <section class="git-provisioning-panel" :aria-label="t('instances.gitProvisioning.progress')">
    <div class="git-provisioning-summary">
      <div>
        <strong>{{ title }}</strong>
        <span>{{ detail }}</span>
      </div>
      <Button variant="ghost" size="sm" :aria-expanded="expanded" @click="toggleExpanded">
        <TerminalSquare :size="14" />
        <span>{{ expanded ? t("instances.gitProvisioning.hideDetails") : t("instances.gitProvisioning.showDetails") }}</span>
        <ChevronDown class="git-provisioning-chevron" :class="{ expanded }" :size="14" />
      </Button>
    </div>
    <Progress v-if="progress.percent !== undefined" :model-value="progress.percent" class="git-provisioning-progress" />
    <div v-show="expanded" class="git-provisioning-terminal-wrap">
      <div ref="terminalHost" class="git-provisioning-terminal" />
      <small v-if="progress.terminalTruncated">{{ t("instances.gitProvisioning.terminalTruncated") }}</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, SquareTerminal as TerminalSquare } from "@lucide/vue";
import type { GitProvisioningProgress } from "@task-handoff/protocol/control-plane";
import { Button } from "../../../components/ui/button";
import { Progress } from "../../../components/ui/progress";
import { gitProvisioningStatusKeys, translateStatus } from "../../../i18n/status.ts";
import { useI18n } from "vue-i18n";

const props = defineProps<{ progress: GitProvisioningProgress }>();
const { t } = useI18n();
const expanded = ref(false);
const terminalHost = ref<HTMLElement>();
let terminal: import("@xterm/xterm").Terminal | undefined;
let fit: import("@xterm/addon-fit").FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let renderedTail = "";

const title = computed(() => translateStatus(gitProvisioningStatusKeys, props.progress.status, t));
const detail = computed(() => {
  const { objects, percent } = props.progress;
  const parts = [objects ? t("instances.gitProvisioning.objects", { received: objects.received, total: objects.total }) : t("instances.gitProvisioning.waitingForOutput")];
  if (percent !== undefined) parts.push(`${Math.round(percent)}%`);
  return parts.join(" · ");
});

async function toggleExpanded() {
  expanded.value = !expanded.value;
  if (!expanded.value) return;
  await nextTick();
  await mountTerminal();
}

async function mountTerminal() {
  if (!terminalHost.value || terminal) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  terminal = new Terminal({
    convertEol: false,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: 12,
    rows: 14,
    theme: terminalTheme(),
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalHost.value);
  fit.fit();
  resizeObserver = new ResizeObserver(() => {
    if (expanded.value) fit?.fit();
  });
  resizeObserver.observe(terminalHost.value);
  syncTerminal(props.progress.terminalTail || "");
}

function syncTerminal(tail: string) {
  if (!terminal) return;
  if (tail.startsWith(renderedTail)) terminal.write(tail.slice(renderedTail.length));
  else { terminal.reset(); terminal.write(tail); }
  renderedTail = tail;
}

function terminalTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim() || "#050505",
    foreground: styles.getPropertyValue("--terminal-text").trim() || "#e8e8e8",
  };
}

watch(() => props.progress.terminalTail || "", syncTerminal);
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminal?.dispose();
});
</script>

<style scoped>
.git-provisioning-panel {
  display: grid;
  gap: 9px;
  margin: 0 0 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-inset);
  padding: 12px;
}

.git-provisioning-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.git-provisioning-summary > div {
  display: grid;
  gap: 2px;
}

.git-provisioning-summary strong { color: var(--text-strong); font-size: 13px; }
.git-provisioning-summary span { color: var(--text-muted); font-size: 12px; }
.git-provisioning-chevron { transition: transform 160ms ease; }
.git-provisioning-chevron.expanded { transform: rotate(180deg); }
.git-provisioning-progress { height: 6px; }
.git-provisioning-terminal-wrap { display: grid; gap: 6px; min-width: 0; }
.git-provisioning-terminal { height: 250px; overflow: hidden; border-radius: 7px; background: var(--terminal-bg, #050505); padding: 8px; }
.git-provisioning-terminal-wrap small { color: var(--text-muted); font-size: 11px; }
</style>
