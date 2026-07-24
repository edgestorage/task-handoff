<template>
  <article ref="card" class="repository-review-diff-card" :data-change-id="changeId">
    <header class="repository-review-diff-head">
      <span class="repository-review-diff-title">
        <FileDiff :size="15" />
        <span><strong>{{ entry.path }}</strong><small>{{ scopeLabel }} · {{ statusLabel }}</small></span>
      </span>
      <span class="repository-review-diff-actions">
        <Button variant="outline" size="sm" @click="$emit('openFiles', entry)"><FileCode2 :size="13" /> Open files</Button>
        <Button v-if="entry.scope === 'staged'" variant="outline" size="sm" :disabled="pending" @click="$emit('unstage', entry)"><ListMinus :size="13" /> Unstage</Button>
        <Button v-else-if="entry.scope !== 'conflict' || entry.status !== 'unmerged'" size="sm" :disabled="pending" @click="$emit('stage', entry)"><ListPlus :size="13" /> Stage</Button>
        <Button v-else size="sm" :disabled="pending" @click="$emit('stage', entry)"><CheckCircle2 :size="13" /> Mark resolved</Button>
        <Button v-if="entry.scope === 'unstaged'" variant="ghost" size="sm" class="repository-review-discard" :disabled="pending" @click="$emit('discard', entry)"><RotateCcw :size="13" /> Discard</Button>
      </span>
    </header>

    <div v-if="pending" class="repository-review-diff-state"><LoaderCircle class="spin" :size="16" /> Updating repository…</div>
    <div v-else-if="diffPending" class="repository-review-diff-state"><LoaderCircle class="spin" :size="16" /> Loading diff…</div>
    <RepositoryErrorNotice v-else-if="error" :error="error" fallback="The file diff could not be loaded." />
    <div v-else-if="diff?.binary" class="repository-review-diff-state"><FileWarning :size="22" /><span><strong>Binary file</strong><small>This change cannot be rendered as text.</small></span></div>
    <template v-else-if="diff">
      <div v-if="diff.truncated" class="repository-review-diff-warning"><FileWarning :size="14" /><span>Only the first {{ diff.byteLimit }} bytes are shown.</span></div>
      <div class="repository-review-diff-table" role="table" :aria-label="`${entry.path} ${scopeLabel} diff`">
        <div v-for="(line, index) in visibleLines" :key="index" class="repository-review-diff-line" :data-kind="line.kind" role="row">
          <span class="repository-review-line-number old" role="cell">{{ line.oldLine || "" }}</span>
          <span class="repository-review-line-number new" role="cell">{{ line.newLine || "" }}</span>
          <span class="repository-review-line-marker" aria-hidden="true">{{ lineMarker(line.kind) }}</span>
          <code role="cell" v-html="line.highlighted || ' '"></code>
        </div>
      </div>
      <div v-if="!visibleLines.length" class="repository-review-diff-state">No textual diff is available.</div>
    </template>
  </article>
</template>

<script setup lang="ts">
import type { RepositoryChangeEntry, RepositoryDiff, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { CheckCircle2, FileCode2, FileDiff, FileWarning, ListMinus, ListPlus, LoaderCircle, RotateCcw } from "@lucide/vue";
import { highlightSource } from "@task-handoff/web-theme/markdown";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRepositoryDiffQuery } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  entry: RepositoryChangeEntry;
  instanceId: string;
  pending: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  snapshotId: string;
}>();

const emit = defineEmits<{
  discard: [entry: RepositoryChangeEntry];
  openFiles: [entry: RepositoryChangeEntry];
  stage: [entry: RepositoryChangeEntry];
  unstage: [entry: RepositoryChangeEntry];
  visible: [entry: RepositoryChangeEntry];
}>();

const card = ref<HTMLElement>();
let visibilityObserver: IntersectionObserver | undefined;

const { data: diff, error, isPending: diffPending } = useRepositoryDiffQuery(
  computed(() => ({ instanceId: props.instanceId, sessionId: props.sessionId, sessionKind: props.sessionKind })),
  computed(() => ({ path: props.entry.path, scope: props.entry.scope, snapshotId: props.snapshotId, version: props.entry.version })),
);

const changeId = computed(() => `${props.entry.scope}:${props.entry.path}`);
const scopeLabel = computed(() => ({ conflict: "Conflict", staged: "Staged", unstaged: "Working tree", untracked: "Untracked" }[props.entry.scope]));
const statusLabel = computed(() => ({ added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", "type-changed": "Type changed", untracked: "Untracked", unmerged: "Unmerged" }[props.entry.status]));
const language = computed(() => languageForPath(props.entry.path));
const visibleLines = computed(() => (diff.value?.lines || [])
  .filter((line) => !isPatchHeader(line))
  .map((line) => ({ ...line, highlighted: highlightSource(line.content, isCodeLine(line) ? language.value : "") })));

onMounted(() => {
  visibilityObserver = new IntersectionObserver((records) => {
    if (records.some((record) => record.isIntersecting && record.intersectionRatio >= 0.15)) emitVisible();
  }, { threshold: [0.15, 0.5] });
  if (card.value) visibilityObserver.observe(card.value);
});

onBeforeUnmount(() => {
  visibilityObserver?.disconnect();
});

function emitVisible() {
  emit("visible", props.entry);
}

function lineMarker(kind: RepositoryDiff["lines"][number]["kind"]) {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "−";
  return "";
}

function isPatchHeader(line: RepositoryDiff["lines"][number]) {
  if (line.kind !== "metadata") return false;
  return /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line.content);
}

function isCodeLine(line: RepositoryDiff["lines"][number]) {
  return line.kind === "context" || line.kind === "addition" || line.kind === "deletion";
}

function languageForPath(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".") ? name.split(".").at(-1) || "" : "";
  return ({
    bash: "bash", c: "cpp", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", cxx: "cpp",
    go: "go", h: "cpp", hpp: "cpp", htm: "xml", html: "xml", java: "java", js: "javascript",
    json: "json", jsonc: "json", jsx: "javascript", kt: "kotlin", kts: "kotlin", less: "css",
    md: "markdown", mjs: "javascript", php: "php", py: "python", rb: "ruby", rs: "rust",
    sass: "css", scss: "css", sh: "bash", sql: "sql", svg: "xml", swift: "swift", ts: "typescript",
    tsx: "typescript", vue: "xml", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash",
  } as Record<string, string>)[extension] || "";
}
</script>

<style scoped>
.repository-review-diff-card { flex: 0 0 auto; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 9px; background: var(--surface); box-shadow: var(--shadow-soft); }
.repository-review-diff-head { position: sticky; top: 0; z-index: 3; display: flex; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-subtle); background: color-mix(in srgb, var(--surface-raised) 96%, transparent); padding: 7px 9px 7px 12px; }
.repository-review-diff-title { display: flex; min-width: 0; align-items: center; gap: 8px; }
.repository-review-diff-title > svg { flex: 0 0 auto; color: var(--brand-accent); }
.repository-review-diff-title > span { display: grid; min-width: 0; gap: 1px; }
.repository-review-diff-title strong { overflow: hidden; color: var(--text-strong); font: 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.repository-review-diff-title small { color: var(--text-muted); font-size: 9px; }
.repository-review-diff-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
.repository-review-diff-actions :deep(button) { height: 27px; gap: 5px; padding: 0 8px; font-size: 9px; }
.repository-review-diff-actions .repository-review-discard { color: var(--status-danger); }
.repository-review-diff-state { display: flex; min-height: 150px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 10px; }
.repository-review-diff-state > span { display: grid; gap: 2px; }
.repository-review-diff-state strong { color: var(--text); }
.repository-review-diff-warning { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid color-mix(in srgb, var(--status-warning) 30%, var(--line-subtle)); background: var(--status-warning-bg); color: var(--status-warning); padding: 7px 12px; font-size: 9px; }
.repository-review-diff-table { min-width: max-content; width: 100%; overflow: auto; background: var(--surface); }
.repository-review-diff-line { display: grid; min-height: 20px; grid-template-columns: 44px 44px 20px minmax(max-content, 1fr); align-items: stretch; font: 10px/20px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.repository-review-diff-line[data-kind="addition"] { background: color-mix(in srgb, var(--status-success) 13%, var(--surface)); }
.repository-review-diff-line[data-kind="deletion"] { background: color-mix(in srgb, var(--status-danger) 12%, var(--surface)); }
.repository-review-diff-line[data-kind="hunk"] { background: color-mix(in srgb, var(--status-info) 12%, var(--surface)); color: var(--status-info); }
.repository-review-diff-line[data-kind="metadata"] { color: var(--text-muted); }
.repository-review-line-number { border-right: 1px solid color-mix(in srgb, var(--line-subtle) 70%, transparent); color: var(--text-subtle); padding: 0 7px; text-align: right; user-select: none; }
.repository-review-line-marker { color: var(--text-muted); text-align: center; user-select: none; }
.repository-review-diff-line code { padding-right: 18px; color: inherit; white-space: pre; }
.repository-review-diff-line code :deep(.hljs-comment), .repository-review-diff-line code :deep(.hljs-quote) { color: var(--text-muted); font-style: italic; }
.repository-review-diff-line code :deep(.hljs-keyword), .repository-review-diff-line code :deep(.hljs-selector-tag), .repository-review-diff-line code :deep(.hljs-doctag) { color: var(--status-danger); font-weight: 650; }
.repository-review-diff-line code :deep(.hljs-string), .repository-review-diff-line code :deep(.hljs-regexp), .repository-review-diff-line code :deep(.hljs-attribute) { color: var(--status-success); }
.repository-review-diff-line code :deep(.hljs-number), .repository-review-diff-line code :deep(.hljs-literal), .repository-review-diff-line code :deep(.hljs-symbol) { color: var(--status-warning); }
.repository-review-diff-line code :deep(.hljs-title), .repository-review-diff-line code :deep(.hljs-section), .repository-review-diff-line code :deep(.hljs-selector-id), .repository-review-diff-line code :deep(.hljs-selector-class) { color: var(--status-info); font-weight: 650; }
.repository-review-diff-line code :deep(.hljs-built_in), .repository-review-diff-line code :deep(.hljs-type), .repository-review-diff-line code :deep(.hljs-class .hljs-title) { color: var(--brand-accent); }
.repository-review-diff-line code :deep(.hljs-meta), .repository-review-diff-line code :deep(.hljs-meta .hljs-keyword) { color: var(--text-muted); }
.repository-review-diff-line code :deep(.hljs-variable), .repository-review-diff-line code :deep(.hljs-template-variable), .repository-review-diff-line code :deep(.hljs-params), .repository-review-diff-line code :deep(.hljs-property) { color: inherit; }
.spin { animation: repository-review-spin 0.9s linear infinite; }
@keyframes repository-review-spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) { .repository-review-diff-actions :deep(button) { padding: 0 6px; } .repository-review-diff-actions :deep(button) { font-size: 0; } }
</style>
