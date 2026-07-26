<template>
  <section class="image-pull-panel" :aria-label="t('instances.imagePull.progress')">
    <div class="image-pull-summary">
      <div>
        <strong>{{ title }}</strong>
        <span>{{ detail }}</span>
      </div>
      <Button variant="ghost" size="sm" :aria-expanded="expanded" @click="toggleExpanded">
        <TerminalSquare :size="14" />
        <span>{{ expanded ? t("instances.imagePull.hideDetails") : t("instances.imagePull.showDetails") }}</span>
        <ChevronDown class="image-pull-chevron" :class="{ expanded }" :size="14" />
      </Button>
    </div>
    <Progress v-if="progress.percent !== undefined" :model-value="progress.percent" class="image-pull-progress" />
    <div v-show="expanded" class="image-pull-terminal-wrap">
      <div ref="terminalHost" class="image-pull-terminal" />
      <small v-if="progress.terminalTruncated">{{ t("instances.imagePull.terminalTruncated") }}</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, SquareTerminal as TerminalSquare } from "@lucide/vue";
import type { ImagePullProgress } from "@task-handoff/protocol/control-plane";
import { Button } from "../../../components/ui/button";
import { Progress } from "../../../components/ui/progress";
import { useControlPlaneLocale } from "../../../i18n/index.ts";
import { formatBytes } from "../../../i18n/presentation.ts";
import { imagePullStatusKeys, translateStatus } from "../../../i18n/status.ts";
import { useI18n } from "vue-i18n";

const props = defineProps<{ progress: ImagePullProgress }>();
const { locale } = useControlPlaneLocale();
const { t } = useI18n();
const expanded = ref(false);
const terminalHost = ref<HTMLElement>();
let terminal: import("@xterm/xterm").Terminal | undefined;
let fit: import("@xterm/addon-fit").FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let renderedTail = "";

const title = computed(() => translateStatus(imagePullStatusKeys, props.progress.status, t));
const detail = computed(() => {
  const { layers, bytes, percent } = props.progress;
  const parts = [layers.total ? t("instances.imagePull.layersReady", { completed: layers.completed, total: layers.total }) : t("instances.imagePull.waitingForLayers")];
  if (layers.downloaded) parts.push(t("instances.imagePull.downloaded", { count: layers.downloaded }));
  if (layers.downloading) parts.push(t("instances.imagePull.downloading", { count: layers.downloading }));
  if (layers.extracting) parts.push(t("instances.imagePull.extractingLayers", { count: layers.extracting }));
  if (bytes) parts.push(`${formatBytes(bytes.current, locale.value)} / ${formatBytes(bytes.total, locale.value)}`);
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
.image-pull-panel {
  display: grid;
  gap: 9px;
  margin: 0 0 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-inset);
  padding: 12px;
}

.image-pull-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.image-pull-summary > div {
  display: grid;
  gap: 2px;
}

.image-pull-summary strong { color: var(--text-strong); font-size: 13px; }
.image-pull-summary span { color: var(--text-muted); font-size: 12px; }
.image-pull-chevron { transition: transform 160ms ease; }
.image-pull-chevron.expanded { transform: rotate(180deg); }
.image-pull-progress { height: 6px; }
.image-pull-terminal-wrap { display: grid; gap: 6px; min-width: 0; }
.image-pull-terminal { height: 250px; overflow: hidden; border-radius: 7px; background: var(--terminal-bg, #050505); padding: 8px; }
.image-pull-terminal-wrap small { color: var(--text-muted); font-size: 11px; }
</style>
