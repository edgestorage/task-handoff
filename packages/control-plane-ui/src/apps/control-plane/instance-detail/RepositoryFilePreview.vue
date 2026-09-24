<template>
  <ScrollArea ref="previewRoot" type="always" class="repository-file-preview-scroll">
    <div class="repository-file-preview-gutter" aria-hidden="true">
      <div ref="gutterLines" class="repository-file-preview-gutter-lines">
        <span v-if="lineNumbers.before" class="repository-file-preview-gutter-numbers">{{ lineNumbers.before }}</span>
        <span v-if="lineNumbers.active" class="repository-file-preview-gutter-numbers" data-active="true">{{ lineNumbers.active }}</span>
        <span v-if="lineNumbers.after" class="repository-file-preview-gutter-numbers">{{ lineNumbers.after }}</span>
      </div>
    </div>
    <pre ref="preview" class="repository-file-preview repository-syntax-highlight" :data-language="language || undefined"><span v-if="validLine" class="repository-file-preview-line" :style="{ top: `${highlightTop}px` }" aria-hidden="true"></span><code :class="{ hljs: language }" v-html="highlightedSource"></code></pre>
  </ScrollArea>
</template>

<script setup lang="ts">
import { highlightSource } from "@task-handoff/web-theme/markdown";
import { computed, nextTick, ref, watch } from "vue";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { repositoryLanguageForPath } from "./repositorySyntaxHighlight";

const props = defineProps<{
  content: string;
  line?: number;
  path: string;
}>();

const previewRoot = ref<InstanceType<typeof ScrollArea>>();
const preview = ref<HTMLElement>();
const gutterLines = ref<HTMLElement>();
const language = computed(() => repositoryLanguageForPath(props.path));
const highlightedSource = computed(() => highlightSource(props.content, language.value));
const lineCount = computed(() => props.content.split("\n").length);
const validLine = computed(() => Number.isInteger(props.line) && Number(props.line) >= 1 && Number(props.line) <= lineCount.value ? Number(props.line) : undefined);
const previewPadding = 16;
const defaultLineHeight = 12 * 1.55;
const lineHeight = ref(defaultLineHeight);
const highlightTop = computed(() => previewPadding + ((validLine.value || 1) - 1) * lineHeight.value);
const lineNumbers = computed(() => {
  const total = lineCount.value;
  const active = validLine.value;
  if (!active) return { before: lineNumberSequence(1, total), active: "", after: "" };
  return { before: lineNumberSequence(1, active - 1), active: String(active), after: lineNumberSequence(active + 1, total) };
});

function lineNumberSequence(from: number, to: number) {
  const numbers: string[] = [];
  for (let line = from; line <= to; line += 1) numbers.push(String(line));
  return numbers.join("\n");
}

function measureLineHeight() {
  const height = gutterLines.value?.getBoundingClientRect().height || 0;
  lineHeight.value = height > 0 && lineCount.value > 0 ? height / lineCount.value : defaultLineHeight;
}

watch([() => props.path, () => props.content, validLine], async ([, , line]) => {
  await nextTick();
  measureLineHeight();
  if (!line) return;
  const viewport = previewRoot.value?.$el?.querySelector("[data-task-handoff-scroll-viewport]") as HTMLElement | null | undefined;
  if (viewport) viewport.scrollTop = Math.max(0, (line - 1) * lineHeight.value - viewport.clientHeight / 2);
}, { immediate: true, flush: "post" });
</script>

<style scoped>
.repository-file-preview-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; background: var(--workspace-bg); }
.repository-file-preview-scroll :deep([data-task-handoff-scroll-viewport]) { width: 100%; height: 100%; }
.repository-file-preview-scroll :deep([data-task-handoff-scroll-viewport] > div) { display: flex; min-width: 100%; width: max-content; min-height: 100%; background: var(--workspace-bg); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 0; }
.repository-file-preview-gutter { position: sticky; z-index: 2; left: 0; flex: none; border-right: 1px solid color-mix(in srgb, var(--line-subtle) 70%, transparent); background: var(--workspace-bg); color: var(--text-subtle); padding: 16px 8px; text-align: right; user-select: none; }
.repository-file-preview-gutter-lines { display: block; }
.repository-file-preview-gutter-numbers { display: block; white-space: pre; }
.repository-file-preview-gutter-numbers[data-active="true"] { background: color-mix(in srgb, var(--brand-accent) 13%, transparent); color: var(--brand-accent); }
.repository-file-preview { position: relative; flex: 1 0 auto; min-width: max-content; min-height: 100%; margin: 0; background: var(--workspace-bg); color: var(--text); font: inherit; padding: 16px; tab-size: 2; white-space: pre; }
.repository-file-preview code { position: relative; z-index: 1; font: inherit; }
.repository-file-preview-line { position: absolute; z-index: 0; left: 0; right: 0; height: 1.55em; border-left: 2px solid var(--brand-accent); background: color-mix(in srgb, var(--brand-accent) 13%, transparent); pointer-events: none; }
</style>
<style scoped src="./RepositorySyntaxHighlight.css"></style>
