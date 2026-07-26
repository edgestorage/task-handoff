<template>
  <pre ref="preview" class="repository-file-preview repository-syntax-highlight" :data-language="language || undefined"><span v-if="validLine" class="repository-file-preview-line" :style="{ top: `${highlightTop}px` }" aria-hidden="true"></span><code :class="{ hljs: language }" v-html="highlightedSource"></code></pre>
</template>

<script setup lang="ts">
import { highlightSource } from "@task-handoff/web-theme/markdown";
import { computed, nextTick, ref, watch } from "vue";
import { repositoryLanguageForPath } from "./repositorySyntaxHighlight";

const props = defineProps<{
  content: string;
  line?: number;
  path: string;
}>();

const preview = ref<HTMLElement>();
const language = computed(() => repositoryLanguageForPath(props.path));
const highlightedSource = computed(() => highlightSource(props.content, language.value));
const lineCount = computed(() => props.content.split("\n").length);
const validLine = computed(() => Number.isInteger(props.line) && Number(props.line) >= 1 && Number(props.line) <= lineCount.value ? Number(props.line) : undefined);
const lineHeight = 12 * 1.55;
const highlightTop = computed(() => 16 + ((validLine.value || 1) - 1) * lineHeight);

watch([() => props.path, () => props.content, validLine], async ([, , line]) => {
  if (!line) return;
  await nextTick();
  if (preview.value) preview.value.scrollTop = Math.max(0, (line - 1) * lineHeight - preview.value.clientHeight / 2);
}, { immediate: true, flush: "post" });
</script>

<style scoped>
.repository-file-preview { position: relative; min-width: 0; min-height: 0; height: 100%; margin: 0; overflow: auto; background: var(--workspace-bg); color: var(--text); padding: 16px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 0; tab-size: 2; white-space: pre; }
.repository-file-preview code { position: relative; z-index: 1; font: inherit; }
.repository-file-preview-line { position: absolute; z-index: 0; left: 0; right: 0; height: 1.55em; border-left: 2px solid var(--brand-accent); background: color-mix(in srgb, var(--brand-accent) 13%, transparent); pointer-events: none; }
</style>
<style scoped src="./RepositorySyntaxHighlight.css"></style>
