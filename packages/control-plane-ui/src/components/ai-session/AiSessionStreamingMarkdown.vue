<template>
  <MarkdownLinkContextMenu :labels="menuLabels" :repository-context="props.repositoryContext" :runtime-cwd="props.runtimeCwd" :runtime-path-access="props.runtimePathAccess" :on-open-file="handleContextFile" :on-open-builtin-browser="openBuiltinBrowser">
    <div class="ai-session-streaming-markdown" @click="handleLinkClick">
      <MarkdownRender
        :content="displayContent"
        :custom-id="markdownScopeId"
        :fade="false"
        :final="isFinal"
        :max-live-nodes="0"
        :batch-rendering="false"
        :smooth-streaming="false"
        :typewriter="false"
        :html-policy="htmlPolicy"
        :is-dark="theme === 'dark'"
        mode="chat"
      />
    </div>
  </MarkdownLinkContextMenu>
</template>

<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import MarkdownRender, { enableKatex, enableMermaid, MermaidBlockNode, setCustomComponents, useSmoothMarkdownStream } from "markstream-vue";
import type { MarkdownCodeTools } from "@task-handoff/web-theme/markdown";
import "markstream-vue/index.css";
import { messageMatchesTurn, useStreamingMessagesStore } from "../../apps/control-plane/useStreamingMessagesStore";
import AiSessionMarkdownNode from "./AiSessionMarkdownNode.vue";
import { resolveFinalReadyAction } from "./aiSessionFinalReady";
import { aiSessionMarkdownCodeToolsKey, defaultAiSessionMarkdownCodeTools } from "./markdown-code-tools";
import MarkdownLinkContextMenu from "./MarkdownLinkContextMenu.vue";
import type { MarkdownLinkTarget } from "./markdown-link-target";
import { openDesktopExternalUrl } from "../../lib/desktopBridge";
import type { RepositoryContext } from "@task-handoff/protocol/repository";
import { useThemePreference } from "../../utils/theme";

enableKatex();
enableMermaid();

const markdownScopeId = "ai-session-streaming-markdown";
setCustomComponents(markdownScopeId, {
  text: AiSessionMarkdownNode,
  code_block: AiSessionMarkdownNode,
  // The code_block override would otherwise swallow ```mermaid fences in the default
  // "pre" rendering mode, so route mermaid fences to markstream's mermaid node.
  mermaid: MermaidBlockNode,
});

const props = withDefaults(defineProps<{
  codeTools?: MarkdownCodeTools;
  content?: unknown;
  fileLinks?: boolean;
  htmlPolicy?: "escape" | "safe" | "trusted";
  instanceId: string;
  isLatest?: boolean;
  providerTurnId?: string;
  repositoryContext?: RepositoryContext;
  runtimeCwd?: string;
  runtimePathAccess?: "desktop-local";
  sessionId: string;
  turnId?: string;
}>(), {
  fileLinks: false,
  htmlPolicy: "escape",
  isLatest: false,
});

provide(aiSessionMarkdownCodeToolsKey, computed(() => props.codeTools ?? defaultAiSessionMarkdownCodeTools));

const emit = defineEmits<{
  openFile: [href: string];
}>();
const { t } = useI18n();
const theme = useThemePreference();
const menuLabels = computed(() => ({
  openFile: t("sessions.markdown.openFile"),
  openDesktopFile: t("sessions.markdown.openDesktopFile"),
  copyPath: t("sessions.markdown.copyPath"),
  openBuiltinBrowser: t("sessions.markdown.openBuiltinBrowser"),
  openDefaultBrowser: t("sessions.markdown.openDefaultBrowser"),
  copyLink: t("sessions.markdown.copyLink"),
}));
function handleContextFile(target: Extract<MarkdownLinkTarget, { kind: "file" }>) { emit("openFile", target.href); }
function openBuiltinBrowser(url: string) {
  window.dispatchEvent(new CustomEvent("task-handoff:open-markdown-browser", { detail: { instanceId: props.instanceId, url } }));
}

function isFileHref(href: string) {
  if (!href || href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) return false;
  if (/^[a-z]:[\\/]/i.test(href)) return true;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return !scheme || scheme === "file";
}

function isWebHref(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function openExternalLink(href: string) {
  const result = await openDesktopExternalUrl(href);
  if (!result.ok && typeof window !== "undefined") window.open(href, "_blank", "noopener,noreferrer");
}

function handleLinkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target.closest("a") : undefined;
  const href = target?.getAttribute("href")?.trim();
  if (!href) return;
  if (isWebHref(href)) {
    event.preventDefault();
    void openExternalLink(href);
    return;
  }
  if (!props.fileLinks || !isFileHref(href)) return;
  event.preventDefault();
  emit("openFile", href);
}

const streamingMessages = useStreamingMessagesStore();
const activeMessage = computed(() => streamingMessages.activeMessage(props.instanceId, props.sessionId));
const streamingState = computed(() => {
  const message = props.isLatest ? activeMessage.value.value?.value : undefined;
  return messageMatchesTurn(message, { id: props.turnId, providerTurnId: props.providerTurnId }) ? message : undefined;
});
const receivedContent = computed(() => String(streamingState.value?.receivedText ?? props.content ?? ""));
const sourceKey = computed(() => streamingState.value?.key || `snapshot:${props.instanceId}:${props.sessionId}`);
const sourceStreaming = computed(() => streamingState.value?.status === "streaming");
const revealEnabled = ref(false);
const activeCharacterAnimations = ref(0);
const pacing = useSmoothMarkdownStream({
  minCharsPerSecond: 30,
  maxCharsPerSecond: 240,
  targetLatencyMs: 240,
  catchUpLatencyMs: 160,
  catchUpThreshold: 48,
  maxCommitFps: 30,
  maxCharsPerCommit: 12,
  startDelayMs: 0,
  flushOnFinish: false,
});
const displayContent = pacing.visible;
const finalReady = ref(false);
const isFinal = computed(() => finalReady.value);

provide("aiSessionCharacterReveal", {
  enabled: revealEnabled,
  begin: () => { activeCharacterAnimations.value += 1; },
  end: () => { activeCharacterAnimations.value = Math.max(0, activeCharacterAnimations.value - 1); },
});

let currentSourceKey = "";
let previousReceivedContent = "";
let previousSourceStreaming = false;
let revealGeneration = 0;
let finalGeneration = 0;

function seedPacing(content: string, streaming: boolean) {
  const generation = ++revealGeneration;
  revealEnabled.value = false;
  pacing.reset(content);
  if (!streaming) pacing.finish({ flush: true });
  void nextTick(() => {
    if (generation === revealGeneration) revealEnabled.value = true;
  });
}

watch(
  [sourceKey, receivedContent, sourceStreaming],
  ([key, content, streaming]) => {
    if (key !== currentSourceKey) {
      currentSourceKey = key;
      previousReceivedContent = content;
      previousSourceStreaming = streaming;
      seedPacing(content, streaming);
      return;
    }

    if (!streaming && !previousSourceStreaming) {
      previousReceivedContent = content;
      seedPacing(content, false);
      return;
    }

    if (streaming && !previousSourceStreaming) pacing.reset(previousReceivedContent);

    if (content.startsWith(previousReceivedContent)) {
      pacing.enqueue(content.slice(previousReceivedContent.length));
    } else if (content !== previousReceivedContent) {
      seedPacing(content, streaming);
    }

    previousReceivedContent = content;
    previousSourceStreaming = streaming;
    if (!streaming) pacing.finish();
  },
  { immediate: true },
);

watch(
  [sourceStreaming, pacing.final, activeCharacterAnimations],
  async ([streaming, pacingFinal, activeAnimations]) => {
    const action = resolveFinalReadyAction({ streaming, pacingFinal, activeAnimations });
    if (action === "reset") {
      finalReady.value = false;
      return;
    }
    if (action === "wait") return;
    const generation = ++finalGeneration;
    await nextTick();
    if (
      generation === finalGeneration
      && !sourceStreaming.value
      && pacing.final.value
      && activeCharacterAnimations.value === 0
    ) finalReady.value = true;
  },
  { immediate: true, flush: "post" },
);
</script>

<style scoped>
.ai-session-streaming-markdown {
  display: block;
  min-width: 0;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.ai-session-streaming-markdown :deep(.markstream-vue) {
  min-width: 0;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  /* Keep markstream's semantic elements on the application's theme contract. */
  --blockquote-border: var(--markdown-border-color, var(--line-strong, currentColor));
  --blockquote-fg: var(--markdown-muted-color, var(--text-muted, currentColor));
  --footnote-border: var(--markdown-border-color, var(--line, currentColor));
  --hr-border: var(--markdown-border-color, var(--line, currentColor));
  --inline-code-bg: var(--markdown-code-bg, var(--surface-inset, rgb(127 127 127 / 14%)));
  --inline-code-border: var(--markdown-border-color, var(--line, transparent));
  --link-color: var(--markdown-link-color, var(--brand-accent, currentColor));
  --list-counter-marker: var(--markdown-text-color, var(--text-strong, currentColor));
  --list-marker: var(--markdown-text-color, var(--text-strong, currentColor));
  --table-border: var(--markdown-table-border, var(--line, currentColor));
  --ms-text-body: 1em;
  --ms-leading-body: 1.55;
  --ms-flow-paragraph-y: 0.6em;
  --ms-flow-list-y: 0.6em;
  --ms-flow-list-item-y: 0.2em;
  --ms-flow-list-indent: 1.7em;
  --ms-flow-blockquote-y: 0.75em;
  --ms-flow-blockquote-indent: 0.9em;
  --ms-flow-codeblock-y: 0.75em;
  --ms-flow-table-y: 0.75em;
  --ms-flow-hr-y: 1em;
  --ms-flow-heading-1-mt: 1em;
  --ms-flow-heading-1-mb: 0.45em;
  --ms-flow-heading-2-mt: 1em;
  --ms-flow-heading-2-mb: 0.45em;
  --ms-flow-heading-3-mt: 1em;
  --ms-flow-heading-3-mb: 0.45em;
  --ms-flow-heading-4-mt: 1em;
  --ms-flow-heading-4-mb: 0.45em;
  --ms-flow-heading-5-mt: 1em;
  --ms-flow-heading-5-mb: 0.45em;
  --ms-flow-heading-6-mt: 1em;
  --ms-flow-heading-6-mb: 0.45em;
  --ms-text-h1: 1.65em;
  --ms-text-h2: 1.4em;
  --ms-text-h3: 1.2em;
  --ms-text-h4: 1.08em;
  --ms-text-h5: 1em;
  --ms-text-h6: 1em;
  --ms-weight-h1: 750;
  --ms-weight-h2: 750;
  --ms-weight-h3: 750;
  --ms-weight-h4: 750;
  --ms-inset-panel-body: 0.8em 0.9em;
  --ms-inset-panel-x: 0.9em;
  --ms-inset-panel-y: 0.45em;
  --ms-radius: 7px;
}

.ai-session-streaming-markdown :deep(.markstream-vue > .node-slot:first-child > .node-content > :first-child) {
  margin-top: 0;
}

.ai-session-streaming-markdown :deep(.markstream-vue > .node-slot:last-child > .node-content > :last-child) {
  margin-bottom: 0;
}

.ai-session-streaming-markdown :deep(.inline-code) {
  border: 1px solid var(--inline-code-border);
  border-radius: 4px;
  background: var(--inline-code-bg);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
  line-height: inherit;
  padding: 0.12em 0.35em;
}

.ai-session-streaming-markdown :deep(del) {
  opacity: 0.72;
}

.ai-session-streaming-markdown :deep(.checkbox-unchecked) {
  color: var(--markdown-muted-color, var(--text-muted, currentColor));
}

.ai-session-streaming-markdown :deep(.checkbox-checked) {
  color: var(--markdown-link-color, var(--brand-accent, currentColor));
}

.ai-session-streaming-markdown :deep(pre) {
  max-width: 100%;
  margin: 0.75em 0;
  overflow: auto;
  border: 1px solid var(--line, transparent);
  border-radius: 7px;
  border-color: var(--line, transparent);
  background: var(--surface-inset, rgb(127 127 127 / 14%));
  box-shadow: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: inherit;
  line-height: 1.55;
  padding: 0.8em 0.9em;
}

.ai-session-streaming-markdown :deep(pre code) {
  border: 0;
  border-radius: 0;
  background: transparent;
  font-family: inherit;
  font-size: 0.9em;
  line-height: 1.55;
  padding: 0;
  white-space: pre;
}

.ai-session-streaming-markdown :deep(.table-node-wrapper) {
  width: fit-content;
  max-width: 100%;
  margin: 0.75em 0;
  overflow-x: auto;
  scrollbar-gutter: auto;
  border: 1px solid var(--markdown-table-border, var(--line, currentColor));
  border-radius: 9px;
  background: var(--markdown-table-bg, var(--surface-raised, transparent));
  box-shadow: var(--shadow-soft, 0 1px 3px rgb(0 0 0 / 12%));
}

.ai-session-streaming-markdown :deep(table.table-node) {
  width: max-content;
  max-width: none;
  margin: 0;
  overflow: visible;
  border: 0;
  border-radius: 0;
  border-collapse: separate;
  border-spacing: 0;
  background: transparent;
  box-shadow: none;
  font-size: 0.95em;
}

.ai-session-streaming-markdown :deep(.table-node th),
.ai-session-streaming-markdown :deep(.table-node td) {
  border: 0;
  border-right: 1px solid var(--markdown-table-border, var(--line, currentColor));
  border-bottom: 1px solid var(--markdown-table-border, var(--line, currentColor));
  padding: 0.62em 0.8em;
  vertical-align: middle;
}

.ai-session-streaming-markdown :deep(.table-node th) {
  background: linear-gradient(
    180deg,
    var(--markdown-table-head-bg, var(--surface-inset, rgb(127 127 127 / 16%))),
    color-mix(in srgb, var(--markdown-table-head-bg, var(--surface-inset, rgb(127 127 127 / 16%))) 78%, transparent)
  );
  color: inherit;
  font-weight: 750;
  white-space: nowrap;
}

.ai-session-streaming-markdown :deep(.table-node tr > :last-child) {
  border-right: 0;
}

.ai-session-streaming-markdown :deep(.table-node tbody tr:last-child > td) {
  border-bottom: 0;
}

.ai-session-streaming-markdown :deep(.table-node tbody tr:nth-child(even) > td) {
  background: var(--markdown-table-stripe-bg, color-mix(in srgb, var(--surface-inset, currentColor) 45%, transparent));
}

.ai-session-streaming-markdown :deep(.table-node tbody tr > td) {
  transition: background-color 120ms ease;
}

.ai-session-streaming-markdown :deep(.table-node tbody tr:hover > td) {
  background: var(--markdown-table-hover-bg, var(--surface-hover, rgb(127 127 127 / 12%)));
}

/* Mermaid teleports its fullscreen view to body. Keep that view on the same
   theme contract as the inline diagram without changing unrelated renderers. */
.ai-session-streaming-markdown :deep(.mermaid-block-container),
:global(.markstream-vue:has(> .mermaid-modal-overlay)) {
  --ms-foreground: var(--foreground);
  --ms-muted-foreground: var(--muted-foreground);
  --ms-accent: var(--accent);
  --ms-accent-foreground: var(--accent-foreground);
  --ms-border: var(--border);
  --ms-ring: var(--ring);
  --diagram-bg: var(--markdown-table-bg, var(--surface-raised));
  --diagram-border: var(--markdown-table-border, var(--line));
  --diagram-header-bg: linear-gradient(
    180deg,
    var(--markdown-table-head-bg, var(--surface-inset)),
    color-mix(in srgb, var(--markdown-table-head-bg, var(--surface-inset)) 78%, transparent)
  );
  --code-fg: var(--markdown-text-color, var(--text-strong));
  --code-action-fg: var(--markdown-muted-color, var(--text-muted));
  --code-action-hover-bg: var(--surface-hover);
  --code-action-hover-fg: var(--text-strong);
  --focus-ring: hsl(var(--ring));
  --modal-bg: var(--surface-overlay);
  --modal-fg: var(--text-strong);
  --ms-shadow-modal: var(--shadow-panel);
  --ms-text-label: 12px;
  --ms-action-btn-padding: 6px;
  --ms-action-btn-icon: 14px;
  --ms-size-diagram-min-height: 240px;
  color: var(--code-fg);
  font-family: inherit;
  font-size: inherit;
  font-weight: 400;
  line-height: 1.5;
}

.ai-session-streaming-markdown :deep(.mermaid-block-container) {
  max-width: 100%;
  margin: 0.75em 0;
  border: 1px solid var(--diagram-border);
  border-radius: 9px;
  background: var(--diagram-bg);
  box-shadow: var(--shadow-soft);
}

.ai-session-streaming-markdown :deep(.mermaid-block-header) {
  min-height: 36px;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 4px 10px;
}

.ai-session-streaming-markdown :deep(.mermaid-label-text) {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
}

.ai-session-streaming-markdown :deep(.mermaid-block-header > .flex:first-child) {
  color: var(--text-muted);
}

.ai-session-streaming-markdown :deep(.mermaid-block-header .icon-slot svg path) {
  stroke: currentColor;
}

.ai-session-streaming-markdown :deep(.mermaid-header-actions) {
  gap: 2px;
}

.ai-session-streaming-markdown :deep(.mermaid-mode-btn),
.ai-session-streaming-markdown :deep(.mermaid-action-btn),
:global(.markstream-vue:has(> .mermaid-modal-overlay) .mermaid-action-btn) {
  min-height: 28px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
}

.ai-session-streaming-markdown :deep(.mermaid-mode-btn) {
  padding: 6px 8px;
  opacity: 1;
}

.ai-session-streaming-markdown :deep(.mermaid-mode-btn:hover) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.ai-session-streaming-markdown :deep(.mermaid-mode-btn.is-active) {
  background: var(--surface-active);
  color: var(--text-strong);
}

.ai-session-streaming-markdown :deep(.mermaid-mode-btn:focus-visible),
.ai-session-streaming-markdown :deep(.mermaid-action-btn:focus-visible),
:global(.markstream-vue:has(> .mermaid-modal-overlay) .mermaid-action-btn:focus-visible) {
  outline: 2px solid var(--focus-ring, var(--brand-accent));
  outline-offset: 1px;
}

.ai-session-streaming-markdown :deep(.mermaid-source-panel) {
  padding: 0;
}

.ai-session-streaming-markdown :deep(pre.mermaid-source-code) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--diagram-bg);
  color: var(--code-fg);
  font-size: 13px;
  line-height: 1.55;
  padding: 12px;
}

:global(.markstream-vue:has(> .mermaid-modal-overlay) .mermaid-modal-panel) {
  border: 1px solid var(--diagram-border);
  border-radius: 9px;
}

.ai-session-streaming-markdown :deep(.hljs-comment),
.ai-session-streaming-markdown :deep(.hljs-quote) {
  color: var(--text-muted, #7f8c8d);
  font-style: italic;
}

.ai-session-streaming-markdown :deep(.hljs-keyword),
.ai-session-streaming-markdown :deep(.hljs-selector-tag),
.ai-session-streaming-markdown :deep(.hljs-doctag) {
  color: var(--status-danger, #d73a49);
  font-weight: 650;
}

.ai-session-streaming-markdown :deep(.hljs-string),
.ai-session-streaming-markdown :deep(.hljs-regexp),
.ai-session-streaming-markdown :deep(.hljs-addition),
.ai-session-streaming-markdown :deep(.hljs-attribute) {
  color: var(--status-success, #22863a);
}

.ai-session-streaming-markdown :deep(.hljs-number),
.ai-session-streaming-markdown :deep(.hljs-literal),
.ai-session-streaming-markdown :deep(.hljs-symbol),
.ai-session-streaming-markdown :deep(.hljs-bullet) {
  color: var(--status-warning, #b08800);
}

.ai-session-streaming-markdown :deep(.hljs-title),
.ai-session-streaming-markdown :deep(.hljs-section),
.ai-session-streaming-markdown :deep(.hljs-selector-id),
.ai-session-streaming-markdown :deep(.hljs-selector-class) {
  color: var(--status-info, #005cc5);
  font-weight: 650;
}

.ai-session-streaming-markdown :deep(.hljs-built_in),
.ai-session-streaming-markdown :deep(.hljs-type),
.ai-session-streaming-markdown :deep(.hljs-class .hljs-title) {
  color: var(--brand-accent, #6f42c1);
}

.ai-session-streaming-markdown :deep(.hljs-meta),
.ai-session-streaming-markdown :deep(.hljs-meta .hljs-keyword) {
  color: var(--text-muted, #6a737d);
}

.ai-session-streaming-markdown :deep(.hljs-deletion) {
  color: var(--status-danger, #b31d28);
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.ai-session-streaming-markdown :deep(.hljs-emphasis) { font-style: italic; }
.ai-session-streaming-markdown :deep(.hljs-strong) { font-weight: 700; }

</style>
