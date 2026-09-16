<template>
  <section class="ai-session-command-result">
    <header class="ai-session-command-result-header">
      <span>{{ t("sessions.timeline.commandShell") }}</span>
      <span v-if="failed" class="ai-session-command-result-exit">{{ t("sessions.timeline.exitCode", { code: exitCode }) }}</span>
      <button v-if="content" type="button" class="ai-session-command-result-copy" :aria-label="t('sessions.timeline.copyOutput')" :title="t('sessions.timeline.copyOutput')" @click="copyOutput">
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
      </button>
    </header>
    <ScrollArea v-if="content" type="auto" class="ai-session-command-result-scroll">
      <pre><code>{{ content }}</code></pre>
    </ScrollArea>
    <div v-else class="ai-session-command-result-empty">{{ t("sessions.timeline.noCommandOutput") }}</div>
  </section>
</template>

<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";
import { ScrollArea } from "../ui/scroll-area";

const props = defineProps<{ command?: string; output?: string; exitCode?: number }>();
const { t } = useI18n();
const copied = ref(false);
const failed = computed(() => props.exitCode !== undefined && props.exitCode !== 0);
const content = computed(() => [props.command ? `$ ${props.command}` : "", props.output || ""].filter(Boolean).join("\n"));
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => { if (copiedTimer) clearTimeout(copiedTimer); });

async function copyOutput() {
  if (!content.value || !navigator.clipboard?.writeText) {
    showControlPlaneToast(t("sessions.actions.copyFailed"));
    return;
  }
  try {
    await navigator.clipboard.writeText(content.value);
    copied.value = true;
    showControlPlaneToast(t("sessions.actions.copied"), "success");
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1_500);
  } catch {
    showControlPlaneToast(t("sessions.actions.copyFailed"));
  }
}
</script>

<style scoped>
.ai-session-command-result { min-width: 0; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--surface); }
.ai-session-command-result-header { display: flex; min-height: 30px; align-items: center; gap: 6px; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised); color: var(--text-muted); font-size: 12px; padding: 0 6px 0 10px; }
.ai-session-command-result-exit { color: var(--status-danger); }
.ai-session-command-result-copy { display: inline-flex; width: 24px; height: 24px; flex: 0 0 auto; align-items: center; justify-content: center; margin-left: auto; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.ai-session-command-result-copy:hover, .ai-session-command-result-copy:focus-visible { outline: 0; background: var(--surface-hover); color: var(--text); }
.ai-session-command-result-scroll { width: 100%; max-height: 320px; }
.ai-session-command-result pre { min-width: max-content; margin: 0; background: transparent; color: var(--text); font: 12px/1.55 var(--font-mono, monospace); letter-spacing: 0; padding: 9px 12px 18px; tab-size: 2; white-space: pre; }
.ai-session-command-result-empty { color: var(--text-muted); font-size: 12px; padding: 13px 11px; }
</style>
