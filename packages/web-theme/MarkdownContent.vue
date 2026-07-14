<template>
  <div ref="root" class="markdown-content" v-html="html" />
</template>

<script setup lang="ts">
import "katex/dist/katex.min.css";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMarkdown } from "./markdown";
import { renderMermaid, type MermaidTheme } from "./mermaid";

const props = defineProps<{
  content?: unknown;
}>();

const root = ref<HTMLElement>();
const html = computed(() => renderMarkdown(props.content));
const mermaidSources = new WeakMap<Element, string>();
let renderVersion = 0;
let themeObserver: MutationObserver | undefined;

function currentMermaidTheme(): MermaidTheme {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") {
    return "dark";
  }
  if (theme === "light") {
    return "default";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default";
}

function showMermaidSource(element: HTMLElement, source: string, error?: string) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.append(code);
  element.replaceChildren(pre);
  if (error) {
    const message = document.createElement("small");
    message.className = "markdown-mermaid-error";
    message.textContent = error;
    element.append(message);
  }
}

async function renderMermaidDiagrams() {
  renderVersion += 1;
  const version = renderVersion;
  await nextTick();
  const container = root.value;
  if (!container) {
    return;
  }

  const diagrams = Array.from(container.querySelectorAll<HTMLElement>(".markdown-mermaid"));
  const theme = currentMermaidTheme();
  for (const diagram of diagrams) {
    const source = mermaidSources.get(diagram) ?? diagram.querySelector("code")?.textContent ?? "";
    mermaidSources.set(diagram, source);
    diagram.dataset.mermaidState = "loading";
    try {
      const result = await renderMermaid(source, theme);
      if (version !== renderVersion || !diagram.isConnected) {
        return;
      }
      diagram.innerHTML = result.svg;
      result.bindFunctions?.(diagram);
      diagram.dataset.mermaidState = "rendered";
    } catch (error) {
      if (version !== renderVersion || !diagram.isConnected) {
        return;
      }
      showMermaidSource(diagram, source, error instanceof Error ? error.message : "Mermaid diagram could not be rendered.");
      diagram.dataset.mermaidState = "error";
    }
  }
}

watch(html, () => void renderMermaidDiagrams(), { flush: "post" });

onMounted(() => {
  void renderMermaidDiagrams();
  themeObserver = new MutationObserver(() => void renderMermaidDiagrams());
  themeObserver.observe(document.documentElement, {
    attributeFilter: ["class", "data-theme"],
    attributes: true,
  });
});

onBeforeUnmount(() => {
  renderVersion += 1;
  themeObserver?.disconnect();
});
</script>

<style scoped>
:where(.markdown-content) {
  min-width: 0;
  color: var(--markdown-text-color, var(--text-strong, currentColor));
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: normal;
}

:where(.markdown-content) :deep(> :first-child) {
  margin-top: 0;
}

:where(.markdown-content) :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(p) {
  margin: 0.6em 0;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 1em 0 0.45em;
  color: inherit;
  font-weight: 750;
  line-height: 1.25;
}

.markdown-content :deep(h1) { font-size: 1.65em; }
.markdown-content :deep(h2) { font-size: 1.4em; }
.markdown-content :deep(h3) { font-size: 1.2em; }
.markdown-content :deep(h4) { font-size: 1.08em; }
.markdown-content :deep(h5),
.markdown-content :deep(h6) { font-size: 1em; }

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.6em 0;
  padding-left: 1.7em;
}

.markdown-content :deep(ul) { list-style: disc; }
.markdown-content :deep(ol) { list-style: decimal; }
.markdown-content :deep(ul ul) { list-style: circle; }
.markdown-content :deep(ul ul ul) { list-style: square; }
.markdown-content :deep(li) { margin: 0.2em 0; }
.markdown-content :deep(li > ul),
.markdown-content :deep(li > ol) { margin: 0.2em 0; }
.markdown-content :deep(li > p) { margin: 0.25em 0; }

.markdown-content :deep(blockquote) {
  margin: 0.75em 0;
  border-left: 3px solid var(--markdown-border-color, var(--line-strong, currentColor));
  color: var(--markdown-muted-color, var(--text-muted, currentColor));
  padding-left: 0.9em;
}

.markdown-content :deep(hr) {
  margin: 1em 0;
  border: 0;
  border-top: 1px solid var(--markdown-border-color, var(--line, currentColor));
}

.markdown-content :deep(code),
.markdown-content :deep(kbd) {
  border: 1px solid var(--markdown-border-color, var(--line, transparent));
  border-radius: 4px;
  background: var(--markdown-code-bg, var(--surface-inset, rgb(127 127 127 / 14%)));
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  padding: 0.12em 0.35em;
}

.markdown-content :deep(pre) {
  max-width: 100%;
  margin: 0.75em 0;
  overflow: auto;
  border: 1px solid var(--markdown-border-color, var(--line, transparent));
  border-radius: 7px;
  background: var(--markdown-code-bg, var(--surface-inset, rgb(127 127 127 / 14%)));
  padding: 0.8em 0.9em;
}

.markdown-content :deep(pre code) {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  white-space: pre;
}

.markdown-content :deep(.hljs-comment),
.markdown-content :deep(.hljs-quote) {
  color: var(--markdown-syntax-comment, var(--text-muted, #7f8c8d));
  font-style: italic;
}

.markdown-content :deep(.hljs-keyword),
.markdown-content :deep(.hljs-selector-tag),
.markdown-content :deep(.hljs-doctag) {
  color: var(--markdown-syntax-keyword, var(--status-danger, #d73a49));
  font-weight: 650;
}

.markdown-content :deep(.hljs-string),
.markdown-content :deep(.hljs-regexp),
.markdown-content :deep(.hljs-addition),
.markdown-content :deep(.hljs-attribute) {
  color: var(--markdown-syntax-string, var(--status-success, #22863a));
}

.markdown-content :deep(.hljs-number),
.markdown-content :deep(.hljs-literal),
.markdown-content :deep(.hljs-symbol),
.markdown-content :deep(.hljs-bullet) {
  color: var(--markdown-syntax-literal, var(--status-warning, #b08800));
}

.markdown-content :deep(.hljs-title),
.markdown-content :deep(.hljs-section),
.markdown-content :deep(.hljs-selector-id),
.markdown-content :deep(.hljs-selector-class) {
  color: var(--markdown-syntax-title, var(--status-info, #005cc5));
  font-weight: 650;
}

.markdown-content :deep(.hljs-built_in),
.markdown-content :deep(.hljs-type),
.markdown-content :deep(.hljs-class .hljs-title) {
  color: var(--markdown-syntax-built-in, var(--brand-accent, #6f42c1));
}

.markdown-content :deep(.hljs-variable),
.markdown-content :deep(.hljs-template-variable),
.markdown-content :deep(.hljs-params),
.markdown-content :deep(.hljs-property) {
  color: var(--markdown-syntax-variable, inherit);
}

.markdown-content :deep(.hljs-meta),
.markdown-content :deep(.hljs-meta .hljs-keyword) {
  color: var(--markdown-syntax-meta, var(--text-muted, #6a737d));
}

.markdown-content :deep(.hljs-deletion) {
  color: var(--markdown-syntax-deletion, var(--status-danger, #b31d28));
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.markdown-content :deep(.hljs-emphasis) { font-style: italic; }
.markdown-content :deep(.hljs-strong) { font-weight: 700; }

.markdown-content :deep(.katex) {
  color: inherit;
  font-size: 1.05em;
}

.markdown-content :deep(.katex-display) {
  max-width: 100%;
  margin: 0.8em 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.3em 0;
}

.markdown-content :deep(.markdown-mermaid) {
  max-width: 100%;
  margin: 0.8em 0;
  overflow: auto;
  border: 1px solid var(--markdown-border-color, var(--line, transparent));
  border-radius: 7px;
  background: var(--markdown-code-bg, var(--surface-inset, rgb(127 127 127 / 14%)));
  padding: 0.8em;
}

.markdown-content :deep(.markdown-mermaid[data-mermaid-state="loading"]) {
  opacity: 0.72;
}

.markdown-content :deep(.markdown-mermaid > pre) {
  margin: 0;
  border: 0;
  background: transparent;
  padding: 0;
}

.markdown-content :deep(.markdown-mermaid svg) {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.markdown-content :deep(.markdown-mermaid-error) {
  display: block;
  margin-top: 0.65em;
  color: var(--status-danger, #d73a49);
  font-size: 0.85em;
  white-space: normal;
}

.markdown-content :deep(a) {
  color: var(--markdown-link-color, var(--brand-accent, currentColor));
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.markdown-content :deep(del) { opacity: 0.72; }

.markdown-content :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0.75em 0;
  border-radius: 6px;
}

.markdown-content :deep(.markdown-table-wrapper) {
  width: fit-content;
  max-width: 100%;
  margin: 0.75em 0;
  overflow-x: auto;
  border: 1px solid var(--markdown-table-border, var(--line, currentColor));
  border-radius: 9px;
  background: var(--markdown-table-bg, var(--surface-raised, transparent));
  box-shadow: var(--shadow-soft, 0 1px 3px rgb(0 0 0 / 12%));
}

.markdown-content :deep(table) {
  width: max-content;
  max-width: none;
  margin: 0;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.95em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 0;
  border-right: 1px solid var(--markdown-table-border, var(--line, currentColor));
  border-bottom: 1px solid var(--markdown-table-border, var(--line, currentColor));
  padding: 0.62em 0.8em;
  text-align: start;
  vertical-align: middle;
}

.markdown-content :deep(th) {
  background: linear-gradient(
    180deg,
    var(--markdown-table-head-bg, var(--surface-inset, rgb(127 127 127 / 16%))),
    color-mix(in srgb, var(--markdown-table-head-bg, var(--surface-inset, rgb(127 127 127 / 16%))) 78%, transparent)
  );
  color: inherit;
  font-weight: 750;
  white-space: nowrap;
}

.markdown-content :deep(tr > :last-child) {
  border-right: 0;
}

.markdown-content :deep(tbody tr:last-child > td) {
  border-bottom: 0;
}

.markdown-content :deep(tbody tr:nth-child(even) > td) {
  background: var(--markdown-table-stripe-bg, color-mix(in srgb, var(--surface-inset, currentColor) 45%, transparent));
}

.markdown-content :deep(tbody tr > td) {
  transition: background-color 120ms ease;
}

.markdown-content :deep(tbody tr:hover > td) {
  background: var(--markdown-table-hover-bg, var(--surface-hover, rgb(127 127 127 / 12%)));
}

.markdown-content :deep(th[align="left"]),
.markdown-content :deep(td[align="left"]) {
  text-align: left;
}

.markdown-content :deep(th[align="center"]),
.markdown-content :deep(td[align="center"]) {
  text-align: center;
}

.markdown-content :deep(th[align="right"]),
.markdown-content :deep(td[align="right"]) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.markdown-content :deep(caption) {
  padding: 0.65em 0.8em;
  color: var(--markdown-muted-color, var(--text-muted, currentColor));
  font-size: 0.9em;
  text-align: start;
}

.markdown-content :deep(input[type="checkbox"]) {
  margin-right: 0.45em;
}
</style>
