import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

test("repository workspace, diff, branch, worktree, and delivery labels render in both locales", () => {
  assert.equal(english("repository.workspace.explorer"), "File Explorer");
  assert.equal(chinese("repository.workspace.explorer"), "文件浏览器");
  assert.equal(english("repository.diff.status.modified"), "Modified");
  assert.equal(chinese("repository.diff.status.modified"), "已修改");
  assert.equal(english("repository.branchesPanel.delete"), "Delete branch");
  assert.equal(chinese("repository.branchesPanel.delete"), "删除分支");
  assert.equal(english("repository.worktreesPanel.remove"), "Remove worktree");
  assert.equal(chinese("repository.worktreesPanel.remove"), "移除工作树");
  assert.equal(english("repository.worktreesPanel.search"), "Search branches, commits, or worktree types…");
  assert.equal(chinese("repository.worktreesPanel.search"), "搜索分支、提交或工作树类型…");
  assert.equal(english("repository.delivery.divergedHint", { ahead: 2, behind: 3 }), "The branch is 2 ahead and 3 behind. Resolve it in the session terminal, then refresh Environment.");
  assert.equal(chinese("repository.delivery.divergedHint", { ahead: 2, behind: 3 }), "分支领先 2、落后 3。请在会话终端中处理后刷新环境。");
});

test("repository-owned content and diagnostic values stay byte-for-byte unchanged", async () => {
  const authoritative = {
    path: "src/原始 path.ts",
    content: "const label = 'Do not translate';\n日志：原样保留\n",
    diffLine: "+provider output --raw",
    terminal: "fatal: upstream rejected refs/heads/main",
    log: "2026-07-26T10:00:00Z git status --porcelain=v2",
  };
  const before = structuredClone(authoritative);

  english("repository.workspace.explorer");
  chinese("repository.workspace.explorer");
  assert.deepEqual(authoritative, before);

  const [workspace, diffCard, worktrees] = await Promise.all([
    readFile(new URL("../src/apps/control-plane/instance-detail/RepositoryWorkspace.vue", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/control-plane/instance-detail/RepositoryChangeDiffCard.vue", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /<RepositoryFilePreview :content="activeTab\.content"[^>]*:path="activeTab\.path"/);
  assert.match(diffCard, /\{\{ line\.hunk\.content \}\}/);
  assert.match(diffCard, /v-html="line\.highlighted \|\| ' '"/);
  assert.match(worktrees, /\{\{ worktree\.lockReason \}\}/);
  assert.doesNotMatch(`${workspace}\n${diffCard}\n${worktrees}`, /(?:^|[^\w.])t\(\s*(?:activeTab\.content|line\.content|worktree\.lockReason)/);
});
