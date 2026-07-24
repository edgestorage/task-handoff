<template>
  <article ref="card" class="repository-review-diff-card" :data-change-id="changeId">
    <header class="repository-review-diff-head">
      <span class="repository-review-diff-title">
        <FileDiff :size="15" />
        <span><strong>{{ entry.path }}</strong><small>{{ scopeLabel }} · {{ statusLabel }}</small></span>
      </span>
      <span class="repository-review-diff-actions">
        <Button v-if="hasExpandedContexts" variant="ghost" size="sm" @click="$emit('collapseContexts', entry)"><FoldVertical :size="13" /> Collapse context</Button>
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
      <div v-if="renderLimitReached" class="repository-review-diff-warning"><FileWarning :size="14" /><span>Only the first {{ maxRenderedLines }} rendered lines are shown.</span></div>
      <div v-if="viewMode === 'unified'" class="repository-review-diff-table" role="table" :aria-label="`${entry.path} ${scopeLabel} unified diff`">
        <template v-for="(line, index) in visibleLines" :key="index">
          <div v-if="line.kind === 'context-control'" class="repository-review-diff-line repository-review-context-tail" :data-kind="line.hunk ? 'hunk' : undefined" :data-hunk-id="line.hunk?.hunkId" role="row">
            <span class="repository-review-hunk-controls" role="cell">
              <button v-for="control in line.controls" :key="contextControlKey(control)" type="button" :data-context-key="contextControlKey(control)" :aria-label="contextControlLabel(control)" :title="contextControlLabel(control)" @click="expandContext(control)">
                <ChevronUp v-if="control.direction === 'up'" :size="13" />
                <ChevronDown v-else :size="13" />
              </button>
            </span>
            <code v-if="line.hunk" role="cell" :title="hunkTitle(line.hunk)">{{ line.hunk.content }}</code>
            <span v-else class="repository-review-context-tail-fill" aria-hidden="true"></span>
          </div>
          <div v-else class="repository-review-diff-line" :data-kind="line.kind" :data-hunk-id="line.kind === 'hunk' ? line.hunkId : undefined" role="row">
            <span class="repository-review-line-number old" role="cell">{{ line.oldLine || "" }}</span>
            <span class="repository-review-line-number new" role="cell">{{ line.newLine || "" }}</span>
            <span class="repository-review-line-marker" aria-hidden="true">{{ lineMarker(line.kind) }}</span>
            <code role="cell" :title="line.kind === 'hunk' ? hunkTitle(line) : undefined" v-html="line.highlighted || ' '"></code>
          </div>
        </template>
      </div>
      <div v-else class="repository-review-diff-table repository-review-split-table" role="table" :aria-label="`${entry.path} ${scopeLabel} split diff`">
        <template v-for="(row, index) in splitRows" :key="index">
          <div v-if="row.kind === 'control'" class="repository-review-diff-line repository-review-context-tail repository-review-split-full" :data-kind="row.control.hunk ? 'hunk' : undefined" :data-hunk-id="row.control.hunk?.hunkId" role="row">
            <span class="repository-review-hunk-controls" role="cell">
              <button v-for="control in row.control.controls" :key="contextControlKey(control)" type="button" :data-context-key="contextControlKey(control)" :aria-label="contextControlLabel(control)" :title="contextControlLabel(control)" @click="expandContext(control)">
                <ChevronUp v-if="control.direction === 'up'" :size="13" />
                <ChevronDown v-else :size="13" />
              </button>
            </span>
            <code v-if="row.control.hunk" role="cell" :title="hunkTitle(row.control.hunk)">{{ row.control.hunk.content }}</code>
            <span v-else class="repository-review-context-tail-fill" aria-hidden="true"></span>
          </div>
          <div v-else-if="row.kind === 'full'" class="repository-review-diff-line repository-review-split-full" :data-kind="row.line.kind" :data-hunk-id="row.line.kind === 'hunk' ? row.line.hunkId : undefined" role="row">
            <span class="repository-review-line-number old" role="cell"></span>
            <span class="repository-review-line-number new" role="cell"></span>
            <span class="repository-review-line-marker"></span>
            <code role="cell" :title="row.line.kind === 'hunk' ? hunkTitle(row.line) : undefined" v-html="row.line.highlighted || ' '"></code>
          </div>
          <div v-else class="repository-review-split-row" role="row">
            <div class="repository-review-split-side old" :data-kind="row.oldLine?.kind" :data-empty="row.oldLine ? undefined : 'true'">
              <span class="repository-review-line-number" role="cell">{{ row.oldLine?.oldLine || "" }}</span>
              <span class="repository-review-line-marker" aria-hidden="true">{{ row.oldLine?.kind === "deletion" ? "−" : "" }}</span>
              <code role="cell" v-html="row.oldLine?.highlighted || ' '"></code>
            </div>
            <div class="repository-review-split-side new" :data-kind="row.newLine?.kind" :data-empty="row.newLine ? undefined : 'true'">
              <span class="repository-review-line-number" role="cell">{{ row.newLine?.newLine || "" }}</span>
              <span class="repository-review-line-marker" aria-hidden="true">{{ row.newLine?.kind === "addition" ? "+" : "" }}</span>
              <code role="cell" v-html="row.newLine?.highlighted || ' '"></code>
            </div>
          </div>
        </template>
      </div>
      <div v-if="!visibleLines.length" class="repository-review-diff-state">No textual diff is available.</div>
    </template>
  </article>
</template>

<script setup lang="ts">
import type { RepositoryChangeEntry, RepositoryDiff, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { CheckCircle2, ChevronDown, ChevronUp, FileCode2, FileDiff, FileWarning, FoldVertical, ListMinus, ListPlus, LoaderCircle, RotateCcw } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRepositoryDiffQuery } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";
import { createSplitRows, diffPresentationRows, highlightedLine, type ContextControl, type ContextDirection, type GapExpansion } from "./repositoryDiffPresentation";

const props = defineProps<{
  entry: RepositoryChangeEntry;
  expandedGaps: ReadonlyMap<string, GapExpansion>;
  instanceId: string;
  pending: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
  snapshotId: string;
  viewMode: "unified" | "split";
}>();

const emit = defineEmits<{
  collapseContexts: [entry: RepositoryChangeEntry];
  discard: [entry: RepositoryChangeEntry];
  expandContext: [entry: RepositoryChangeEntry, gapId: string, direction: ContextDirection, lineCount: number];
  openFiles: [entry: RepositoryChangeEntry];
  stage: [entry: RepositoryChangeEntry];
  unstage: [entry: RepositoryChangeEntry];
  visible: [entry: RepositoryChangeEntry];
}>();

const card = ref<HTMLElement>();
let visibilityObserver: IntersectionObserver | undefined;
const maxRenderedLines = 3_000;
const contextLineLimit = computed(() => Math.min(3_000, Math.max(20, Math.max(0, ...[...props.expandedGaps.values()].flatMap((gap) => [gap.fromStart, gap.fromEnd])) + 20)));

const { data: diff, error, isPending: diffPending } = useRepositoryDiffQuery(
  computed(() => ({ instanceId: props.instanceId, sessionId: props.sessionId, sessionKind: props.sessionKind })),
  computed(() => ({ path: props.entry.path, scope: props.entry.scope, snapshotId: props.snapshotId, version: props.entry.version, contextLines: contextLineLimit.value })),
);

const changeId = computed(() => `${props.entry.scope}:${props.entry.path}`);
const scopeLabel = computed(() => ({ conflict: "Conflict", staged: "Staged", unstaged: "Working tree", untracked: "Untracked" }[props.entry.scope]));
const statusLabel = computed(() => ({ added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", "type-changed": "Type changed", untracked: "Untracked", unmerged: "Unmerged" }[props.entry.status]));
const language = computed(() => languageForPath(props.entry.path));
const hasExpandedContexts = computed(() => [...props.expandedGaps.values()].some((gap) => gap.fromStart > 0 || gap.fromEnd > 0));
const displaySourceLines = computed(() => diffPresentationRows(diff.value, props.expandedGaps).filter((line) => line.kind === "context-control" || !isPatchHeader(line)));
const renderLimitReached = computed(() => displaySourceLines.value.length > maxRenderedLines);
const visibleLines = computed(() => displaySourceLines.value.slice(0, maxRenderedLines)
  .map((line) => line.kind === "context-control" ? line : ({ ...line, highlighted: highlightedLine(line, language.value) })));
const splitRows = computed(() => createSplitRows(visibleLines.value));

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

function contextControlLabel(control: ContextControl) {
  return `Expand ${control.lineCount} ${control.direction === "up" ? "earlier" : "later"} lines`;
}

function contextControlKey(control: ContextControl) {
  return `${control.gapId}:${control.direction}`;
}

async function expandContext(control: ContextControl) {
  const scrollContainer = card.value?.closest<HTMLElement>(".repository-review-content");
  const anchor = contextControlElement(control.gapId, control.direction);
  const containingHunkId = anchor?.closest<HTMLElement>("[data-hunk-id]")?.dataset.hunkId;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const cardHeight = card.value?.getBoundingClientRect().height;
  emit("expandContext", props.entry, control.gapId, control.direction, control.lineCount);
  await nextTick();
  if (control.direction === "up") return;
  requestAnimationFrame(() => {
    if (!scrollContainer || anchorTop === undefined) return;
    const nextAnchor = contextControlElement(control.gapId, control.direction)
      || (containingHunkId ? diffHunkElement(containingHunkId) : undefined);
    if (nextAnchor) {
      scrollContainer.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
    } else if (cardHeight !== undefined && card.value) {
      scrollContainer.scrollTop += card.value.getBoundingClientRect().height - cardHeight;
    }
  });
}

function contextControlElement(gapId: string, direction: ContextDirection) {
  return card.value?.querySelector<HTMLElement>(`[data-context-key="${CSS.escape(contextControlKey({ gapId, direction, lineCount: 0 }))}"]`);
}

function diffHunkElement(hunkId: string) {
  return [...(card.value?.querySelectorAll<HTMLElement>("[data-hunk-id]") || [])].find((element) => element.dataset.hunkId === hunkId);
}

function hunkTitle(line: RepositoryDiff["lines"][number]) {
  if (line.kind !== "hunk" || line.oldStart === undefined || line.oldCount === undefined || line.newStart === undefined || line.newCount === undefined) return line.content;
  return `Old lines ${rangeLabel(line.oldStart, line.oldCount)}; new lines ${rangeLabel(line.newStart, line.newCount)}`;
}

function rangeLabel(start: number, count: number) {
  if (!count) return "none";
  return count === 1 ? `${start}` : `${start}-${start + count - 1}`;
}

function isPatchHeader(line: RepositoryDiff["lines"][number]) {
  if (line.kind !== "metadata") return false;
  return /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line.content);
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
.repository-review-diff-title strong { overflow: hidden; color: var(--text-strong); font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.repository-review-diff-title small { color: var(--text-muted); font-size: 12px; }
.repository-review-diff-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
.repository-review-diff-actions :deep(button) { height: 27px; gap: 5px; padding: 0 8px; font-size: 12px; }
.repository-review-diff-actions .repository-review-discard { color: var(--status-danger); }
.repository-review-diff-state { display: flex; min-height: 150px; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.repository-review-diff-state > span { display: grid; gap: 2px; }
.repository-review-diff-state strong { color: var(--text); }
.repository-review-diff-warning { display: flex; align-items: center; gap: 7px; border-bottom: 1px solid color-mix(in srgb, var(--status-warning) 30%, var(--line-subtle)); background: var(--status-warning-bg); color: var(--status-warning); padding: 7px 12px; font-size: 12px; }
.repository-review-diff-table { min-width: max-content; width: 100%; overflow: auto; background: var(--surface); }
.repository-review-diff-line { display: grid; min-height: 20px; grid-template-columns: 44px 44px 20px minmax(max-content, 1fr); align-items: stretch; font: 12px/20px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.repository-review-diff-line[data-kind="addition"] { background: color-mix(in srgb, var(--status-success) 13%, var(--surface)); }
.repository-review-diff-line[data-kind="deletion"] { background: color-mix(in srgb, var(--status-danger) 12%, var(--surface)); }
.repository-review-diff-line[data-kind="hunk"] { background: color-mix(in srgb, var(--status-info) 12%, var(--surface)); color: var(--status-info); }
.repository-review-diff-line[data-kind="metadata"] { color: var(--text-muted); }
.repository-review-hunk-controls { display: flex; grid-column: 1 / 3; align-items: stretch; justify-content: center; border-right: 1px solid color-mix(in srgb, var(--status-info) 22%, var(--line-subtle)); }
.repository-review-hunk-controls button { display: inline-flex; width: 100%; min-height: 20px; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--status-info); cursor: pointer; padding: 0; }
.repository-review-hunk-controls button:hover, .repository-review-hunk-controls button:focus-visible { outline: 0; background: color-mix(in srgb, var(--status-info) 16%, transparent); }
.repository-review-diff-line[data-kind="hunk"] code { grid-column: 4; }
.repository-review-context-tail { background: color-mix(in srgb, var(--status-info) 12%, var(--surface)); }
.repository-review-context-tail-fill { grid-column: 4; }
.repository-review-line-number { border-right: 1px solid color-mix(in srgb, var(--line-subtle) 70%, transparent); color: var(--text-subtle); padding: 0 7px; text-align: right; user-select: none; }
.repository-review-line-marker { color: var(--text-muted); text-align: center; user-select: none; }
.repository-review-diff-line code { padding-right: 18px; color: inherit; white-space: pre; }
.repository-review-split-table { min-width: 900px; }
.repository-review-split-full { width: 100%; }
.repository-review-split-table .repository-review-context-tail { grid-template-columns: 44px 20px minmax(max-content, 1fr); }
.repository-review-split-table .repository-review-context-tail .repository-review-hunk-controls { grid-column: 1; }
.repository-review-split-table .repository-review-context-tail code,
.repository-review-split-table .repository-review-context-tail .repository-review-context-tail-fill { grid-column: 3; }
.repository-review-split-row { display: grid; min-height: 20px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); font: 12px/20px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.repository-review-split-side { display: grid; min-width: 0; overflow: hidden; grid-template-columns: 44px 20px minmax(0, 1fr); }
.repository-review-split-side.old { border-right: 1px solid var(--line-subtle); }
.repository-review-split-side[data-kind="deletion"] { background: color-mix(in srgb, var(--status-danger) 12%, var(--surface)); }
.repository-review-split-side[data-kind="addition"] { background: color-mix(in srgb, var(--status-success) 13%, var(--surface)); }
.repository-review-split-side[data-empty="true"] { background: var(--surface-inset); }
.repository-review-split-side code { min-width: 0; overflow: hidden; padding-right: 18px; color: inherit; white-space: pre; }
.repository-review-diff-card code :deep(.hljs-comment), .repository-review-diff-card code :deep(.hljs-quote) { color: var(--text-muted); font-style: italic; }
.repository-review-diff-card code :deep(.hljs-keyword), .repository-review-diff-card code :deep(.hljs-selector-tag), .repository-review-diff-card code :deep(.hljs-doctag) { color: var(--status-danger); font-weight: 650; }
.repository-review-diff-card code :deep(.hljs-string), .repository-review-diff-card code :deep(.hljs-regexp), .repository-review-diff-card code :deep(.hljs-attribute) { color: var(--status-success); }
.repository-review-diff-card code :deep(.hljs-number), .repository-review-diff-card code :deep(.hljs-literal), .repository-review-diff-card code :deep(.hljs-symbol) { color: var(--status-warning); }
.repository-review-diff-card code :deep(.hljs-title), .repository-review-diff-card code :deep(.hljs-section), .repository-review-diff-card code :deep(.hljs-selector-id), .repository-review-diff-card code :deep(.hljs-selector-class) { color: var(--status-info); font-weight: 650; }
.repository-review-diff-card code :deep(.hljs-built_in), .repository-review-diff-card code :deep(.hljs-type), .repository-review-diff-card code :deep(.hljs-class .hljs-title) { color: var(--brand-accent); }
.repository-review-diff-card code :deep(.hljs-meta), .repository-review-diff-card code :deep(.hljs-meta .hljs-keyword) { color: var(--text-muted); }
.repository-review-diff-card code :deep(.hljs-variable), .repository-review-diff-card code :deep(.hljs-template-variable), .repository-review-diff-card code :deep(.hljs-params), .repository-review-diff-card code :deep(.hljs-property) { color: inherit; }
.spin { animation: repository-review-spin 0.9s linear infinite; }
@keyframes repository-review-spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) { .repository-review-diff-actions :deep(button) { justify-content: center; gap: 0; padding: 0 6px; font-size: 0; } }
</style>
