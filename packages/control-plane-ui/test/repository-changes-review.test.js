import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoot = new URL("../src/apps/control-plane/instance-detail/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, detailRoot), "utf8");
}

test("repository changes review opens as an independent reusable session tab", async () => {
  const [environment, sessions, pane, review] = await Promise.all([
    source("RepositoryEnvironment.vue"),
    source("useActiveInstanceSessions.ts"),
    source("SessionPaneContent.vue"),
    source("RepositoryChangesReviewTab.vue"),
  ]);

  assert.match(environment, /repository\.environment\.review/);
  assert.match(environment, /page: "changes-review"/);
  assert.match(environment, /runPrimaryAction[\s\S]*openChangesReview\(\)/);
  assert.match(sessions, /repository-changes:\$\{target\.sessionKind\}:\$\{target\.sessionId\}/);
  assert.match(sessions, /page === "changes-review"/);
  assert.match(pane, /RepositoryChangesReviewTab[\s\S]*session\.source\?\.page === 'changes-review'/);
  assert.match(pane, /RepositoryWorkspaceTab v-else-if="session\?\.kind === 'repository'"/);
  assert.match(review, /function openFiles\(\) \{[\s\S]*props\.session\.source\?\.cwdFolderId[\s\S]*\.\.\.\(typeof cwdFolderId === "string" && cwdFolderId \? \{ cwdFolderId \} : \{\}\)/);
});

test("changes review keeps a changed-file tree beside continuous authoritative diffs", async () => {
  const [review, card, presentation, sourceLanguage, repositoryApi] = await Promise.all([
    source("RepositoryChangesReviewTab.vue"),
    source("RepositoryChangeDiffCard.vue"),
    source("repositoryDiffPresentation.ts"),
    readFile(new URL("../src/components/source-code/sourceLanguage.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api/repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(review, /<RepositoryFilePicker v-model:open="filesOpen" v-model:search="filter"/);
  assert.match(review, /<RepositoryFileTree[^>]*:nodes="reviewTreeNodes"/);
  assert.match(review, /class="repository-review-files-trigger"/);
  assert.match(review, /filesOpen\.value = false;[\s\S]*rowVirtualizer\.value\.scrollToIndex/);
  assert.doesNotMatch(review, /repository-review-body \{[^}]*grid-template-columns:/);
  assert.match(review, /reviewTreeNodes = computed<RepositoryFileTreeNode\[\]>/);
  assert.match(review, /function buildTree\(entries: RepositoryChangeEntry\[\]\)/);
  assert.match(review, /useVirtualizer\(computed/);
  assert.match(review, /<ScrollArea type="auto" :horizontal="false" class="repository-review-content">/);
  assert.match(review, /\.repository-review-content \{[^}]*grid-row: 2;/);
  assert.match(review, /scrollContent\.value\?\.closest<HTMLElement>\("\[data-task-handoff-scroll-viewport\]"\)/);
  assert.match(review, /getScrollElement: \(\) => scrollViewport\.value \|\| null/);
  assert.match(review, /v-for="virtualRow in virtualRows"/);
  assert.match(review, /:ref="measureVirtualRow"/);
  assert.match(review, /rowVirtualizer\.value\.measureElement/);
  assert.match(review, /overscan: 3/);
  assert.match(review, /repository\.reviewExtra\.all[\s\S]*repository\.review\.working[\s\S]*repository\.review\.staged[\s\S]*repository\.review\.conflicts/);
  assert.match(review, /stageRepositoryPaths/);
  assert.match(review, /unstageRepositoryPaths/);
  assert.match(review, /discardRepositoryWorktree/);
  assert.match(review, /expectedSnapshotId: requireSnapshotId\(\)/);
  assert.match(review, /:snapshot-id="changes\?\.snapshotId \|\| ''"/);
  assert.match(review, /:expanded-gaps="expandedGapsFor/);
  assert.match(review, /expandedGaps = reactive\(new Map/);
  assert.match(review, /:collapsed="collapsedChanges\.has\(changeId/);
  assert.match(review, /collapsedChanges = reactive\(new Set<string>\(\)\)/);
  assert.match(review, /function toggleCollapsed\(entry: RepositoryChangeEntry\)/);
  assert.match(card, /class="repository-review-diff-head" @click="\$emit\('toggleCollapsed', entry\)"/);
  assert.match(card, /<button type="button" class="repository-review-diff-title" :aria-expanded="!collapsed">/);
  assert.match(card, /<template v-if="!collapsed">/);
  assert.match(review, /function expandContext\(entry: RepositoryChangeEntry, gapId: string, direction: ContextDirection, lineCount: number\)/);
  assert.match(review, /function collapseContexts\(entry: RepositoryChangeEntry\)[\s\S]*expandedGaps\.delete\(key\)/);
  assert.match(review, /<ToggleGroup[\s\S]*value="unified"[\s\S]*value="split"/);
  assert.match(review, /function setViewMode\(value: unknown\)/);
  assert.match(review, /:view-mode="viewMode"/);
  assert.match(card, /useRepositoryDiffQuery/);
  assert.match(card, /class="repository-review-hunk-controls"/);
  assert.match(card, /\.repository-review-hunk-controls \{[^}]*grid-column: 1 \/ 3;/);
  assert.match(card, /v-for="control in line\.controls"/);
  assert.match(card, /control\.direction === 'up'/);
  assert.doesNotMatch(card, /contextControls/);
  assert.match(card, /line\.hunk\.content/);
  assert.match(card, /class="repository-review-diff-line repository-review-context-tail"/);
  assert.match(card, /\.repository-review-diff-line\[data-kind="hunk"\] code \{ grid-column: 4; \}/);
  assert.match(card, /v-if="hasExpandedContexts"[\s\S]*repository\.diff\.collapse/);
  assert.match(card, /contextControlLabel[\s\S]*emit\("expandContext", props\.entry, control\.gapId, control\.direction, control\.lineCount\)/);
  assert.doesNotMatch(card, /repository-review-context-control|data-expanded/);
  assert.match(card, /containingHunkId = anchor\?\.closest<HTMLElement>\("\[data-hunk-id\]"\)/);
  assert.match(card, /if \(control\.direction === "up"\) return;/);
  assert.match(card, /contextControlElement\(control\.gapId, control\.direction\)[\s\S]*diffHunkElement\(containingHunkId\)/);
  assert.match(card, /const scrollContainer = pageScrollViewport\(\);/);
  assert.match(card, /function pageScrollViewport\(\)[\s\S]*hasAttribute\("data-task-handoff-scroll-viewport"\)/);
  assert.match(card, /scrollContainer\.scrollTop \+= nextAnchor\.getBoundingClientRect\(\)\.top - anchorTop/);
  assert.match(card, /card\.value\.getBoundingClientRect\(\)\.height - cardHeight/);
  assert.match(card, /function hunkTitle/);
  assert.match(card, /viewMode === 'unified'/);
  assert.match(card, /class="repository-review-split-pane" :data-side="side"/);
  assert.match(card, /\.repository-review-split-table \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(card, /\.repository-review-split-lines \.repository-review-diff-line \{[^}]*grid-template-columns: 44px 20px minmax\(max-content, 1fr\);/);
  assert.match(card, /\.repository-review-split-lines \.repository-review-hunk-controls \{ grid-column: 1; \}/);
  assert.match(card, /\.repository-review-split-lines \.repository-review-context-tail code,[\s\S]*\.repository-review-context-tail \.repository-review-context-tail-fill \{ grid-column: 3; \}/);
  assert.doesNotMatch(card, /\.repository-review-split-side|min-width: 900px/);
  assert.match(card, /createSplitRows\(visibleLines\.value\)/);
  assert.match(card, /@container repository-review \(max-width: 720px\)[\s\S]*\.repository-review-diff-card \{[^}]*border-radius: 0;[^}]*box-shadow: none;[^}]*\}/);
  assert.match(card, /\.repository-review-diff-actions :deep\(button\) \{[^}]*justify-content: center;[^}]*gap: 0;[^}]*font-size: 0;/);
  assert.match(presentation, /export function createSplitRows/);
  assert.match(presentation, /function alignChangedLines/);
  assert.match(presentation, /lineSimilarity/);
  assert.doesNotMatch(card, /const diff = ref|const requested = ref|loadObserver/);
  assert.match(repositoryApi, /"repository-diff"[\s\S]*snapshotId[\s\S]*scope[\s\S]*path[\s\S]*version/);
  assert.match(repositoryApi, /placeholderData:[\s\S]*sameDiffContext/);
  assert.match(repositoryApi, /previousKey\.slice\(0, -1\)[\s\S]*currentKey\[index\]/);
  assert.match(presentation, /WeakMap/);
  assert.match(presentation, /diffPresentationRows/);
  assert.match(presentation, /expandedGaps: ReadonlyMap<string, GapExpansion>/);
  assert.match(presentation, /remainingLoaded <= contextChunkSize/);
  assert.match(card, /maxRenderedLines = 3_000/);
  assert.deepEqual(review.match(/font(?:-size|):\s*(?:8|9|10|11)px/g), ["font-size: 10px", "font-size: 10px"]);
  assert.match(review, /\.repository-review-files-trigger b \{[^}]*font-size: 10px;/);
  assert.match(review, /\.repository-review-scopes b \{[^}]*font-size: 10px;/);
  assert.match(review, /\.repository-review-page \{[^}]*container: repository-review \/ inline-size;/);
  assert.match(review, /@container repository-review \(max-width: 720px\)/);
  assert.match(review, /compactLayout = computed\(\(\) => reviewWidth\.value > 0 && reviewWidth\.value <= 720\)/);
  assert.match(review, /gap: compactLayout\.value \? 0 : 13/);
  assert.match(review, /\.repository-review-toolbar-left \{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(review, /\.repository-review-page \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(review, /\.repository-review-scopes \{[^}]*grid-auto-columns: minmax\(max-content, 1fr\);[^}]*overflow-x: auto;/);
  assert.match(review, /@container repository-review \(max-width: 560px\)[\s\S]*\.repository-review-view-options :deep\(button\) \{ width: 28px;[^}]*font-size: 0;/);
  assert.match(card, /<ScrollArea v-if="viewMode === 'unified'" type="auto" class="repository-review-diff-table"/);
  assert.match(card, /<ScrollArea v-for="side in splitSides" :key="side" type="auto" class="repository-review-split-pane"/);
  assert.match(card, /\.repository-review-diff-lines, \.repository-review-split-lines \{ min-width: 100%; width: max-content;/);
  assert.match(card, /\.repository-review-diff-line > \.repository-review-line-number,[\s\S]*\.repository-review-diff-line > \.repository-review-hunk-controls \{ position: sticky; z-index: 1;/);
  assert.match(card, /\.repository-review-diff-lines \.repository-review-line-number\.new \{ left: 44px; \}/);
  assert.match(card, /\.repository-review-split-lines \.repository-review-line-marker \{ left: 44px; \}/);
  assert.doesNotMatch(card, /\.repository-review-diff-table \{[^}]*min-width: max-content/);
  assert.match(review, /\.repository-review-virtual-list \{ width: 100%; margin: 0; \}/);
  assert.doesNotMatch(review, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(card, /font(?:-size|):\s*(?:8|9|10|11)px/);
  assert.match(card, /v-for="\(line, index\) in visibleLines"/);
  assert.match(card, /function isPatchHeader[\s\S]*diff --git[\s\S]*index[\s\S]*---[\s\S]*\\\+\\\+\\\+/);
  assert.match(card, /highlightedLine\(line, language\.value\)/);
  assert.match(card, /repositoryLanguageForPath\(props\.entry\.path\)/);
  assert.match(sourceLanguage, /tsx: "typescript"[\s\S]*vue: "xml"/);
  assert.match(card, /v-html="line\.highlighted/);
  assert.match(card, /\.repository-review-diff-card \{[^}]*flex: 0 0 auto;[^}]*overflow: clip;/);
  assert.match(card, /\.repository-review-diff-head \{[^}]*position: sticky;[^}]*top: 0;/);
  assert.match(review, /:style="\{ top: `\$\{virtualRow\.start\}px` \}"/);
  assert.doesNotMatch(review, /translateY\(\$\{virtualRow\.start\}/);
  assert.doesNotMatch(card, /split\("\\n"\)|parseUnified|content\.split/);
  assert.match(card, /entry\.scope === 'staged'[\s\S]*repository\.diff\.unstage/);
  assert.match(card, /entry\.scope === 'unstaged'[\s\S]*repository\.diff\.discard/);
  assert.doesNotMatch(card, /<Button[^>]*variant="ghost"[^>]*repository\.diff\.(?:collapse|discard)/);
  assert.match(card, /\.repository-review-diff-actions :deep\(button\) \{[^}]*height: 28px;[^}]*border-color: var\(--line-subtle\);[^}]*background: var\(--surface-inset\);[^}]*box-shadow: none;/);
  assert.match(card, /\.repository-review-diff-actions \.repository-review-discard:hover \{[^}]*background: var\(--status-danger-bg\);/);
});
