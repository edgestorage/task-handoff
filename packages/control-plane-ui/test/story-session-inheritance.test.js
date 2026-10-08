import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sourceRoot = new URL("../src/apps/control-plane/", import.meta.url);
const storyView = fs.readFileSync(new URL("story/StoryView.vue", sourceRoot), "utf8");
const aiSessionPanel = fs.readFileSync(new URL("instance-detail/AiSessionPanel.vue", sourceRoot), "utf8");

test("a new Story session inherits the newest session through the shared Story session derivation", () => {
  assert.match(storyView, /import \{ allNodesVisible, controlPlaneAgentCapabilities, latestStorySessionForCreation, nodeIsVisible, storySessionRootsInForest, type NodeVisibilityFilter \} from "@task-handoff\/control-plane-client";/);
  assert.match(storyView, /const storySessionRootsFor = \(story: Story\) => storySessionRootsInForest\(\s*storySessionForest\.value,\s*story\.id,\s*instancesForStory\(story\)\.map\(\(instance\) => instance\.id\),\s*\);/);
  assert.match(storyView, /const latestSessionFor = \(story: Story\) => \{[\s\S]*?latestStorySessionForCreation\([\s\S]*?storySessionForest\.value,\s*story\.id,\s*instancesForStory\(story\)\.map\(\(instance\) => instance\.id\),[\s\S]*?\);/);
});

test("the Story composer passes the inherited session so its worktree can be inherited too", () => {
  assert.match(storyView, /const newSessionInitialWorktreeSessionId = ref\(""\);/);
  assert.match(storyView, /newSessionInitialWorktreeSessionId\.value = latest\?\.session\.id \|\| "";/);
  assert.match(storyView, /function selectCreationInstance\(instanceId: string\) \{ newSessionInstanceId\.value = instanceId; newSessionInitialCwd\.value = ""; newSessionInitialCwdFolderId\.value = ""; newSessionInitialWorktreeSessionId\.value = ""; \}/);
  assert.match(storyView, /:creation-initial-worktree-session-id="newSessionInitialWorktreeSessionId"/);
  assert.match(aiSessionPanel, /creationInitialWorktreeSessionId\?: string;/);
});

test("the inherited worktree comes from the session repository context and is applied once", () => {
  assert.match(aiSessionPanel, /import \{ createRepositoryWorkspaceWorktree, getRepositoryContext \} from "\.\.\/\.\.\/\.\.\/api\/repository";/);
  assert.match(aiSessionPanel, /void getRepositoryContext\(\{ instanceId, sessionKind: "ai-session", sessionId \}, \{ signal: abort\.signal \}\)/);
  assert.match(aiSessionPanel, /creationInheritedWorktreeId\.value = context\.currentWorktree\?\.id \|\| "";/);
  assert.match(aiSessionPanel, /function applyCreationInitialWorktree\(workspace: RepositoryAiSessionWorkspace\) \{[\s\S]*?if \(creationInitialWorktreeApplied === appliedKey\) return;[\s\S]*?const worktree = \(workspace\.worktrees \|\| \[\]\)\.find\(\(candidate\) => candidate\.id === worktreeId\);[\s\S]*?if \(!worktree \|\| worktree\.isCurrent \|\| !worktree\.canCreateAiSession\) return;[\s\S]*?newSessionWorkspaceMode\.value = "worktree";\s*newSessionWorktreeId\.value = worktreeId;/);
  assert.match(aiSessionPanel, /if \(cachedWorkspace\) \{\s*applyCreationInitialWorktree\(cachedWorkspace\);\s*syncNewSessionBranchFromWorkspace\(cachedWorkspace\);\s*\}/);
  assert.match(aiSessionPanel, /newSessionWorkspace\.value = workspace;\s*applyCreationInitialWorktree\(workspace\);\s*syncNewSessionBranchFromWorkspace\(workspace\);/);
});
