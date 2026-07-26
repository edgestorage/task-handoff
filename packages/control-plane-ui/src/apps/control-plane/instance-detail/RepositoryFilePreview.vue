<template>
  <pre class="repository-file-preview repository-syntax-highlight" :data-language="language || undefined"><code :class="{ hljs: language }" v-html="highlightedSource"></code></pre>
</template>

<script setup lang="ts">
import { highlightSource } from "@task-handoff/web-theme/markdown";
import { computed } from "vue";
import { repositoryLanguageForPath } from "./repositorySyntaxHighlight";

const props = defineProps<{
  content: string;
  path: string;
}>();

const language = computed(() => repositoryLanguageForPath(props.path));
const highlightedSource = computed(() => highlightSource(props.content, language.value));
</script>

<style scoped>
.repository-file-preview { min-width: 0; min-height: 0; height: 100%; margin: 0; overflow: auto; background: var(--workspace-bg); color: var(--text); padding: 16px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 0; tab-size: 2; white-space: pre; }
.repository-file-preview code { font: inherit; }
</style>
<style scoped src="./RepositorySyntaxHighlight.css"></style>
