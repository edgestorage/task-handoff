<template>
  <section class="ai-session-activity-result">
    <header class="ai-session-activity-result-header">
      <span class="ai-session-activity-result-title">{{ shell ? t("sessions.timeline.commandShell") : title }}</span>
      <span v-if="showExitCode" :class="{ 'ai-session-activity-result-exit': exitCode !== 0 }">{{ t("sessions.timeline.exitCode", { code: exitCode }) }}</span>
      <button v-if="content" type="button" class="ai-session-activity-result-copy" :aria-label="copyLabel" :title="copyLabel" @click="copyContent">
        <Check v-if="copied" :size="14" aria-hidden="true" />
        <Copy v-else :size="14" aria-hidden="true" />
      </button>
    </header>
    <ScrollArea v-if="content" type="auto" class="ai-session-activity-result-scroll">
      <div class="ai-session-activity-result-body" :class="{ 'ai-session-activity-result-body-labelled': showLabels }">
        <div v-if="inputText">
          <div v-if="showLabels" class="ai-session-activity-result-label">{{ t("sessions.timeline.input") }}</div>
          <pre :class="{ 'ai-session-activity-result-command': shell }"><code>{{ inputText }}</code></pre>
        </div>
        <div v-if="output">
          <div v-if="showLabels" class="ai-session-activity-result-label">{{ t("sessions.timeline.output") }}</div>
          <pre><code>{{ output }}</code></pre>
        </div>
      </div>
    </ScrollArea>
    <div v-else-if="shell" class="ai-session-activity-result-empty">{{ t("sessions.timeline.noCommandOutput") }}</div>
  </section>
</template>

<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";
import { ScrollArea } from "../ui/scroll-area";

const props = defineProps<{ title: string; shell?: boolean; input?: string; output?: string; exitCode?: number }>();
const { t } = useI18n();
const copied = ref(false);
const showExitCode = computed(() => props.exitCode !== undefined && (!props.shell || props.exitCode !== 0));
const inputText = computed(() => props.shell && props.input ? `$ ${props.input}` : props.input);
const showLabels = computed(() => !props.shell && Boolean(props.input && props.output));
const content = computed(() => [inputText.value, props.output].filter(Boolean).join(props.shell ? "\n" : "\n\n"));
const copyLabel = computed(() => t(props.shell ? "sessions.timeline.copyOutput" : "sessions.timeline.copyDetails"));
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => { if (copiedTimer) clearTimeout(copiedTimer); });

async function copyContent() {
  if (!content.value || !navigator.clipboard?.writeText) {
    showControlPlaneToast(t("sessions.actions.copyFailed"), "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(content.value);
    copied.value = true;
    showControlPlaneToast(t("sessions.actions.copied"), "success");
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1_500);
  } catch {
    showControlPlaneToast(t("sessions.actions.copyFailed"), "error");
  }
}
</script>

<style scoped>
.ai-session-activity-result { min-width: 0; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--surface); }
.ai-session-activity-result-header { display: flex; min-height: 30px; align-items: center; gap: 6px; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised); color: var(--text-muted); font-size: 12px; padding: 0 6px 0 10px; }
.ai-session-activity-result-title { min-width: 0; overflow-wrap: anywhere; }
.ai-session-activity-result-exit { color: var(--status-danger); }
.ai-session-activity-result-copy { display: inline-flex; width: 24px; height: 24px; flex: 0 0 auto; align-items: center; justify-content: center; margin-left: auto; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.ai-session-activity-result-copy:hover, .ai-session-activity-result-copy:focus-visible { background: var(--surface-hover); color: var(--text); }
.ai-session-activity-result-scroll { width: 100%; }
.ai-session-activity-result-scroll :deep([data-task-handoff-scroll-viewport]) { max-height: 320px; }
.ai-session-activity-result-body { min-width: max-content; padding: 9px 12px 18px; }
.ai-session-activity-result-body-labelled { display: grid; gap: 12px; }
.ai-session-activity-result-label { color: var(--text-muted); font-size: 12px; margin-bottom: 4px; }
.ai-session-activity-result pre { margin: 0; background: transparent; color: var(--text); font: 12px/1.55 var(--font-mono, monospace); letter-spacing: 0; tab-size: 2; white-space: pre; cursor: text; -webkit-user-select: text; user-select: text; }
.ai-session-activity-result pre.ai-session-activity-result-command { color: var(--text-muted); }
.ai-session-activity-result-empty { color: var(--text-muted); font-size: 12px; padding: 13px 11px; }
</style>
