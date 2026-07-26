import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoot = new URL("../src/apps/control-plane/instance-detail/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, detailRoot), "utf8");
}

test("repository changes review opens as an independent reusable session tab", async () => {
  const [environment, sessions, pane] = await Promise.all([
    source("RepositoryEnvironment.vue"),
    source("useActiveInstanceSessions.ts"),
    source("SessionPaneContent.vue"),
  ]);

  assert.match(environment, />Review changes</);
  assert.match(environment, /page: "changes-review"/);
  assert.match(environment, /runPrimaryAction[\s\S]*openChangesReview\(\)/);
  assert.match(sessions, /repository-changes:\$\{target\.sessionKind\}:\$\{target\.sessionId\}/);
  assert.match(sessions, /label: page === "changes-review" \? "Changes" : "File Explorer"/);
  assert.match(pane, /RepositoryChangesReviewTab[\s\S]*session\.source\?\.page === 'changes-review'/);
  assert.match(pane, /RepositoryWorkspaceTab v-else-if="session\?\.kind === 'repository'"/);
});

test("changes review keeps a changed-file tree beside continuous authoritative diffs", async () => {
  const [review, card, presentation, syntaxHighlight, repositoryApi] = await Promise.all([
    source("RepositoryChangesReviewTab.vue"),
    source("RepositoryChangeDiffCard.vue"),
    source("repositoryDiffPresentation.ts"),
    source("repositorySyntaxHighlight.ts"),
    readFile(new URL("../src/api/repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(review, /class="repository-review-tree" role="tree"/);
  assert.match(review, /<Popover v-model:open="filesOpen">[\s\S]*class="repository-review-files-popover p-0"/);
  assert.match(review, /<PopoverContent[^>]*:collision-padding="12"/);
  assert.match(review, /class="repository-review-files-trigger"/);
  assert.match(review, /filesOpen\.value = false;[\s\S]*rowVirtualizer\.value\.scrollToIndex/);
  assert.doesNotMatch(review, /repository-review-body \{[^}]*grid-template-columns:/);
  assert.match(review, /\.repository-review-files-popover\) \{[^}]*height: min\(680px, var\(--reka-popover-content-available-height, calc\(100vh - 24px\)\)\);/);
  assert.match(review, /function buildTree\(entries: RepositoryChangeEntry\[\]\)/);
  assert.match(review, /useVirtualizer\(computed/);
  assert.match(review, /v-for="virtualRow in virtualRows"/);
  assert.match(review, /:ref="measureVirtualRow"/);
  assert.match(review, /rowVirtualizer\.value\.measureElement/);
  assert.match(review, /overscan: 3/);
  assert.match(review, /All[\s\S]*Working[\s\S]*Staged[\s\S]*Conflicts/);
  assert.match(review, /stageRepositoryPaths/);
  assert.match(review, /unstageRepositoryPaths/);
  assert.match(review, /discardRepositoryWorktree/);
  assert.match(review, /expectedSnapshotId: requireSnapshotId\(\)/);
  assert.match(review, /:snapshot-id="changes\?\.snapshotId \|\| ''"/);
  assert.match(review, /:expanded-gaps="expandedGapsFor/);
  assert.match(review, /expandedGaps = reactive\(new Map/);
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
  assert.match(card, /v-if="hasExpandedContexts"[\s\S]*Collapse context/);
  assert.match(card, /contextControlLabel[\s\S]*emit\("expandContext", props\.entry, control\.gapId, control\.direction, control\.lineCount\)/);
  assert.doesNotMatch(card, /repository-review-context-control|data-expanded/);
  assert.match(card, /containingHunkId = anchor\?\.closest<HTMLElement>\("\[data-hunk-id\]"\)/);
  assert.match(card, /if \(control\.direction === "up"\) return;/);
  assert.match(card, /contextControlElement\(control\.gapId, control\.direction\)[\s\S]*diffHunkElement\(containingHunkId\)/);
  assert.match(card, /scrollContainer\.scrollTop \+= nextAnchor\.getBoundingClientRect\(\)\.top - anchorTop/);
  assert.match(card, /card\.value\.getBoundingClientRect\(\)\.height - cardHeight/);
  assert.match(card, /function hunkTitle/);
  assert.match(card, /viewMode === 'unified'/);
  assert.match(card, /class="repository-review-split-row"/);
  assert.match(card, /\.repository-review-split-table \.repository-review-context-tail \{[^}]*grid-template-columns: 44px 20px minmax\(max-content, 1fr\);/);
  assert.match(card, /\.repository-review-split-table \.repository-review-context-tail \.repository-review-hunk-controls \{[^}]*grid-column: 1;/);
  assert.match(card, /\.repository-review-split-table \.repository-review-context-tail code,[\s\S]*\.repository-review-context-tail-fill \{ grid-column: 3; \}/);
  assert.match(card, /\.repository-review-split-side \{[^}]*overflow: hidden;[^}]*minmax\(0, 1fr\);/);
  assert.match(card, /\.repository-review-split-side code \{[^}]*overflow: hidden;/);
  assert.match(card, /createSplitRows\(visibleLines\.value\)/);
  assert.match(card, /@media \(max-width: 900px\)[^{]*\{[^}]*\.repository-review-diff-actions :deep\(button\) \{[^}]*justify-content: center;[^}]*gap: 0;[^}]*font-size: 0;/);
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
  assert.doesNotMatch(card, /font(?:-size|):\s*(?:8|9|10|11)px/);
  assert.match(card, /v-for="\(line, index\) in visibleLines"/);
  assert.match(card, /function isPatchHeader[\s\S]*diff --git[\s\S]*index[\s\S]*---[\s\S]*\\\+\\\+\\\+/);
  assert.match(card, /highlightedLine\(line, language\.value\)/);
  assert.match(card, /repositoryLanguageForPath\(props\.entry\.path\)/);
  assert.match(syntaxHighlight, /tsx: "typescript"[\s\S]*vue: "xml"/);
  assert.match(card, /v-html="line\.highlighted/);
  assert.match(card, /\.repository-review-diff-card \{[^}]*flex: 0 0 auto;/);
  assert.doesNotMatch(card, /split\("\\n"\)|parseUnified|content\.split/);
  assert.match(card, /entry\.scope === 'staged'[\s\S]*Unstage/);
  assert.match(card, /entry\.scope === 'unstaged'[\s\S]*Discard/);
});
