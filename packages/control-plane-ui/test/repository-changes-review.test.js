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
  assert.match(sessions, /label: page === "changes-review" \? "Changes" : "Repository"/);
  assert.match(pane, /RepositoryChangesReviewTab[\s\S]*session\.source\?\.page === 'changes-review'/);
  assert.match(pane, /RepositoryWorkspaceTab v-else-if="session\?\.kind === 'repository'"/);
});

test("changes review keeps a changed-file tree beside continuous authoritative diffs", async () => {
  const [review, card, repositoryApi] = await Promise.all([
    source("RepositoryChangesReviewTab.vue"),
    source("RepositoryChangeDiffCard.vue"),
    readFile(new URL("../src/api/repository.ts", import.meta.url), "utf8"),
  ]);

  assert.match(review, /class="repository-review-tree" role="tree"/);
  assert.match(review, /<Popover v-model:open="filesOpen">[\s\S]*class="repository-review-files-popover"/);
  assert.match(review, /class="repository-review-files-trigger"/);
  assert.match(review, /filesOpen\.value = false;[\s\S]*rowVirtualizer\.value\.scrollToIndex/);
  assert.doesNotMatch(review, /repository-review-body \{[^}]*grid-template-columns:/);
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
  assert.match(card, /useRepositoryDiffQuery/);
  assert.doesNotMatch(card, /const diff = ref|const requested = ref|loadObserver/);
  assert.match(repositoryApi, /"repository-diff"[\s\S]*snapshotId[\s\S]*scope[\s\S]*path[\s\S]*version/);
  assert.match(repositoryApi, /gcTime: 30 \* 60 \* 1000[\s\S]*staleTime: Infinity/);
  assert.match(card, /v-for="\(line, index\) in visibleLines"/);
  assert.match(card, /function isPatchHeader[\s\S]*diff --git[\s\S]*index[\s\S]*---[\s\S]*\\\+\\\+\\\+/);
  assert.match(card, /highlightSource\(line\.content, isCodeLine\(line\) \? language\.value : ""\)/);
  assert.match(card, /function languageForPath[\s\S]*tsx: "typescript"[\s\S]*vue: "xml"/);
  assert.match(card, /v-html="line\.highlighted/);
  assert.match(card, /\.repository-review-diff-card \{[^}]*flex: 0 0 auto;/);
  assert.doesNotMatch(card, /split\("\\n"\)|parseUnified|content\.split/);
  assert.match(card, /entry\.scope === 'staged'[\s\S]*Unstage/);
  assert.match(card, /entry\.scope === 'unstaged'[\s\S]*Discard/);
});
