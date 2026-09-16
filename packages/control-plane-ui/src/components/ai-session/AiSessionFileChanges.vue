<template>
  <div class="ai-session-file-changes repository-syntax-highlight">
    <article v-for="change in renderedChanges" :key="`${change.path}:${change.movePath || ''}`" class="ai-session-file-change">
      <header class="ai-session-file-change-header">
        <span class="ai-session-file-change-name" :title="change.movePath || change.path">{{ fileName(change.movePath || change.path) }}</span>
        <span class="ai-session-file-change-counts" aria-hidden="true">
          <span class="additions">+{{ change.additions }}</span>
          <span class="deletions">-{{ change.deletions }}</span>
        </span>
        <button type="button" class="ai-session-file-change-copy" :aria-label="t('sessions.timeline.copyDiff')" :title="t('sessions.timeline.copyDiff')" @click="copyDiff(change.diff)">
          <Check v-if="copiedDiff === change.diff" :size="14" />
          <Copy v-else :size="14" />
        </button>
      </header>
      <ScrollArea type="auto" class="ai-session-file-change-scroll">
        <div class="ai-session-file-change-table" role="table" :aria-label="t('sessions.timeline.fileDiff', { path: change.movePath || change.path })">
          <div v-for="(line, index) in change.lines" :key="index" class="ai-session-file-change-line" :data-kind="line.kind" role="row">
            <span class="ai-session-file-change-number" role="cell">{{ line.oldLine || "" }}</span>
            <span class="ai-session-file-change-number" role="cell">{{ line.newLine || "" }}</span>
            <span class="ai-session-file-change-marker" aria-hidden="true">{{ marker(line.kind) }}</span>
            <code role="cell" v-html="line.highlighted || ' '"></code>
          </div>
          <div v-if="!change.lines.length" class="ai-session-file-change-empty">{{ t("sessions.timeline.noFileDiff") }}</div>
        </div>
      </ScrollArea>
    </article>
  </div>
</template>

<script setup lang="ts">
import { highlightSource } from "@task-handoff/web-theme/markdown";
import { Check, Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { showControlPlaneToast } from "../../apps/control-plane/useControlPlaneToasts";
import { sourceLanguageForPath } from "../source-code/sourceLanguage";
import { ScrollArea } from "../ui/scroll-area";
import { parseAiSessionDiff, type AiSessionFileChange } from "./aiSessionFileChanges";

const props = defineProps<{ changes: AiSessionFileChange[] }>();
const { t } = useI18n();
const copiedDiff = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const renderedChanges = computed(() => props.changes.map((change) => {
  const language = sourceLanguageForPath(change.movePath || change.path);
  const lines = parseAiSessionDiff(change.diff).map((line) => ({ ...line, highlighted: highlightSource(line.content, language) }));
  return {
    ...change,
    lines,
    additions: lines.filter((line) => line.kind === "addition").length,
    deletions: lines.filter((line) => line.kind === "deletion").length,
  };
}));

onBeforeUnmount(() => { if (copiedTimer) clearTimeout(copiedTimer); });

function fileName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

function marker(kind: "context" | "addition" | "deletion") {
  return kind === "addition" ? "+" : kind === "deletion" ? "-" : "";
}

async function copyDiff(diff: string) {
  if (!navigator.clipboard?.writeText) {
    showControlPlaneToast(t("sessions.actions.copyFailed"));
    return;
  }
  try {
    await navigator.clipboard.writeText(diff);
    copiedDiff.value = diff;
    showControlPlaneToast(t("sessions.actions.copied"), "success");
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedDiff.value = ""; }, 1_500);
  } catch {
    showControlPlaneToast(t("sessions.actions.copyFailed"));
  }
}
</script>

<style scoped>
.ai-session-file-changes { display: grid; gap: 8px; min-width: 0; }
.ai-session-file-change { min-width: 0; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--surface); }
.ai-session-file-change-header { display: flex; min-height: 30px; align-items: center; gap: 6px; border-bottom: 1px solid var(--line-subtle); background: var(--surface-raised); padding: 0 6px 0 10px; }
.ai-session-file-change-name { min-width: 0; overflow: hidden; color: var(--text-strong); font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.ai-session-file-change-counts { display: flex; flex: 0 0 auto; gap: 5px; font: 12px/1 var(--font-mono, monospace); }
.ai-session-file-change-counts .additions { color: var(--status-success); }
.ai-session-file-change-counts .deletions { color: var(--status-danger); }
.ai-session-file-change-copy { display: inline-flex; width: 24px; height: 24px; flex: 0 0 auto; align-items: center; justify-content: center; margin-left: auto; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.ai-session-file-change-copy:hover, .ai-session-file-change-copy:focus-visible { outline: 0; background: var(--surface-hover); color: var(--text); }
.ai-session-file-change-scroll { width: 100%; max-height: 360px; }
.ai-session-file-change-table { min-width: max-content; width: 100%; background: var(--surface); padding-bottom: 10px; }
.ai-session-file-change-line { display: grid; min-height: 21px; grid-template-columns: 42px 42px 20px minmax(max-content, 1fr); font: 12px/21px var(--font-mono, monospace); }
.ai-session-file-change-line[data-kind="addition"] { background: color-mix(in srgb, var(--status-success) 13%, var(--surface)); }
.ai-session-file-change-line[data-kind="deletion"] { background: color-mix(in srgb, var(--status-danger) 12%, var(--surface)); }
.ai-session-file-change-number { border-right: 1px solid color-mix(in srgb, var(--line-subtle) 70%, transparent); color: var(--text-subtle); padding: 0 7px; text-align: right; user-select: none; }
.ai-session-file-change-marker { color: var(--text-muted); text-align: center; user-select: none; }
.ai-session-file-change-line code { padding-right: 18px; color: var(--text); white-space: pre; }
.ai-session-file-change-empty { min-width: min(320px, 100%); color: var(--text-muted); font-size: 12px; padding: 14px 12px 4px; }
</style>
<style scoped src="../../apps/control-plane/instance-detail/RepositorySyntaxHighlight.css"></style>
