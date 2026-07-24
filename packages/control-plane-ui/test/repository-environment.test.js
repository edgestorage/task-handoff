import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../src/", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("AI and app session details share the session-scoped Environment entry", async () => {
  const [aiPanel, preview] = await Promise.all([
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
  ]);

  assert.match(aiPanel, /<RepositoryEnvironment[\s\S]*:session-id="selectedSession\.id"[\s\S]*session-kind="ai-session"/);
  assert.match(preview, /<RepositoryEnvironment[\s\S]*:session-id="activeRepositorySessionId"[\s\S]*session-kind="app-session"/);
  assert.doesNotMatch(`${aiPanel}\n${preview}`, /:execution-location=/);
});

test("Environment uses a portal popover and authoritative repository context", async () => {
  const [component, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(component, /PopoverContent/);
  assert.match(component, /context\.primaryAction/);
  assert.match(component, /Files \/ Changes/);
  assert.match(component, /Worktree/);
  assert.match(component, /Branch/);
  assert.doesNotMatch(component, /executionLocation|<Laptop/);
  assert.match(repositoryApi, /\/instances\/\$\{encodeURIComponent\(target\.instanceId\)\}\/api\/\$\{sessionCollection\}\/\$\{encodeURIComponent\(target\.sessionId\)\}\/repository/);
  assert.match(repositoryApi, /RepositoryWorktreesSchema\.safeParse/);
  assert.match(repositoryApi, /Restart the instance to load the current protocol/);
  const contextClient = repositoryApi.slice(repositoryApi.indexOf("export function getRepositoryContext"), repositoryApi.indexOf("export function getRepositoryWorktrees"));
  assert.doesNotMatch(contextClient, /[?&](cwd|path|repositoryRoot)=/);
});

test("Worktrees use opaque server ids and expose AI-session creation without cwd switching", async () => {
  const [environment, panel, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(environment, /class="repository-worktrees-popover"/);
  assert.match(panel, /Current/);
  assert.match(panel, /Managed/);
  assert.match(panel, /Dirty/);
  assert.match(panel, /Locked/);
  assert.match(panel, /active session/);
  assert.match(panel, /New AI session here/);
  assert.match(panel, /<strong :title="worktreeLabel\(worktree\)">/);
  assert.match(panel, /\.repository-worktree-list \{[\s\S]*overflow-x: hidden/);
  assert.match(panel, /\.repository-worktree-branch \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: hidden/);
  assert.match(environment, /class="repository-environment-branch-summary" :title="branchSummary"/);
  assert.match(environment, /\.repository-environment-branch-summary \{[\s\S]*white-space: nowrap/);
  assert.match(panel, /repositoryContextId: worktrees\.value\.repositoryContextId/);
  assert.match(panel, /worktreeId: worktree\.id/);
  assert.doesNotMatch(panel, /workspaceSelection:[\s\S]*\b(cwd|path)\s*:/);
  assert.match(repositoryApi, /target\.sessionKind !== "ai-session"/);
});

test("managed worktree creation launches a new session without a client filesystem path", async () => {
  const [panel, aiPanel, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(panel, /New isolated AI session/);
  assert.match(panel, /mode: "new-branch", branchName, startRef, expectedSnapshotId/);
  assert.match(panel, /The current session stays in this worktree/);
  assert.match(panel, /worktreeRemoved/);
  assert.match(panel, /recoverable/);
  assert.match(panel, /\.repository-worktree-list \{[\s\S]*gap: 2px/);
  assert.match(panel, /\.repository-worktree-card \{[\s\S]*gap: 5px;[\s\S]*border: 0;[\s\S]*background: transparent;[\s\S]*padding: 7px 8px/);
  assert.match(panel, /\.repository-worktree-card\[data-current="true"\] \{[\s\S]*background: color-mix\(in srgb, var\(--brand-accent\) 9%, transparent\)/);
  assert.match(panel, /\.repository-worktree-card\[data-current="true"\] \.repository-worktree-branch strong,[\s\S]*color: var\(--brand-accent-muted, var\(--brand-accent\)\)/);
  assert.match(repositoryApi, /\/worktrees\/ai-sessions/);
  assert.doesNotMatch(panel, /worktree:\s*\{[^}]*\b(path|cwd)\s*:/);
  assert.match(aiPanel, /pendingRepositoryAppSessionId\.value = result\.appSessionId/);
  assert.match(aiPanel, /item\.appSessionId === result\.appSessionId/);
  assert.match(aiPanel, /emit\("selectAiSession", props\.instance\.id, session\.id\)/);
});

test("managed worktree removal is AI-only, confirmed, non-force, and retains the branch", async () => {
  const [panel, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(panel, /canManageWorktrees = computed\(\(\) => props\.sessionKind === "ai-session"\)/);
  assert.match(panel, /This deletes the managed worktree directory/);
  assert.match(panel, /The Git branch is retained/);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /expectedSnapshotId: worktrees\.value\.snapshotId/);
  assert.match(panel, /worktree\.removeBlockers/);
  assert.match(repositoryApi, /\/worktrees\/remove/);
  assert.doesNotMatch(`${panel}\n${repositoryApi}`, /\bforce\s*:/);
});

test("branch selector groups, searches, tracks, checks out, and safely deletes server branches", async () => {
  const [environment, panel, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryBranchesPanel.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(environment, /repository-branches-popover/);
  assert.match(panel, /Search branches/);
  assert.match(panel, /Remote-tracking/);
  assert.match(panel, /\.repository-branches-panel \{ display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden/);
  assert.match(panel, /\.repository-branch-groups \{[\s\S]*flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*overflow-y: auto/);
  assert.match(panel, /scrollbar-gutter: stable/);
  assert.match(panel, /buildBranchTree\(filteredLocal\.value, "local"\)/);
  assert.match(panel, /buildBranchTree\(filteredRemote\.value, "remote"\)/);
  assert.match(panel, /branch\.name\.split\("\/"\)/);
  assert.match(panel, /aria-expanded="node\.expanded"/);
  assert.match(panel, /:title="node\.branch\.name"/);
  assert.match(panel, /repository-branch-folder-count/);
  assert.match(panel, /countBranchLeaves\(node\)/);
  assert.match(panel, /width: `calc\(100% - \$\{inset \+ 2\}px\)`/);
  assert.match(panel, /repository-branch-row\[data-current="true"\] \.repository-branch-name \{ color: var\(--brand-accent-muted, var\(--brand-accent\)\); \}/);
  assert.doesNotMatch(panel, /repository-branch-row\[data-current="true"\][^{]*\{[^}]*box-shadow/);
  assert.match(panel, /\.repository-branch-row\.remote \{ min-height: 34px; \}/);
  assert.match(panel, /\.repository-branch-row\.remote \.repository-branch-select \{ padding-block: 3px; \}/);
  assert.match(panel, /Boolean\(normalizedSearch\.value\) \|\| !collapsedFolders\.value\.has\(node\.id\)/);
  assert.match(panel, /currentChangeCount/);
  assert.match(panel, /checkedOutWorktreeIds/);
  assert.match(panel, /remoteTrackingRef: trackingTarget\.value!\.name/);
  assert.match(panel, /confirm: true/);
  assert.match(panel, /Force deletion is not available/);
  assert.match(panel, /queryClient\.setQueryData\(\["repository-context"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "checkout"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "tracking"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "delete"/);
  assert.doesNotMatch(`${panel}\n${repositoryApi}`, /\bforce\s*:/);
});

test("Repository workspace opens as a session tab with a resizable ScrollArea sidebar", async () => {
  const [environment, workspace, workspaceTab, sessionState, tree, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspaceTab.vue"),
    source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts"),
    source("apps/control-plane/instance-detail/RepositoryFileTree.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(environment, /emit\("openWorkspace", \{ initialView: view, sessionId: props\.sessionId, sessionKind: props\.sessionKind \}\)/);
  assert.match(workspaceTab, /<RepositoryWorkspace[\s\S]*embedded/);
  assert.match(workspaceTab, /:embedded="!dialogOpen"/);
  assert.match(workspace, /aria-label="Open repository workspace as dialog"/);
  assert.match(workspace, /aria-label="Return repository workspace to tab"/);
  assert.match(sessionState, /kind: "repository"/);
  assert.match(sessionState, /function openRepositoryWorkspace\(target: RepositoryWorkspaceTabTarget\)/);
  assert.match(workspace, /RepositoryFileTree/);
  assert.match(workspace, /<ScrollArea type="always" class="repository-workspace-sidebar-content">/);
  assert.match(workspace, /role="separator" aria-label="Resize repository sidebar"/);
  assert.match(workspace, /function startSidebarResize\(event: PointerEvent\)/);
  assert.match(workspace, /Conflicts/);
  assert.match(workspace, /Staged/);
  assert.match(workspace, /Unstaged/);
  assert.match(workspace, /Untracked/);
  assert.match(workspace, /<textarea[^>]*v-model="activeTab\.draft"/);
  assert.match(workspace, /<pre>\{\{ activeTab\.content \}\}<\/pre>/);
  assert.match(workspace, /Binary diff cannot be displayed/);
  assert.match(workspace, /repository-workspace-dialog[^}]*top: calc\(50% \+ 24px\)[^}]*height: min\(920px, calc\(100vh - 80px\)\)/);
  assert.match(workspace, /repository-workspace-empty[^}]*grid-row: 2/);
  assert.match(tree, /entry\.traversable/);
  assert.match(repositoryApi, /getRepositoryDirectory/);
  assert.match(repositoryApi, /getRepositoryFile/);
  assert.match(repositoryApi, /getRepositoryDiff/);
});

test("Repository workspace can move to a recoverable authenticated window", async () => {
  const [app, workspace, page, windowHelper] = await Promise.all([
    source("App.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspacePage.vue"),
    source("apps/control-plane/instance-detail/repositoryWorkspaceWindow.ts"),
  ]);

  assert.match(app, /RepositoryWorkspacePage v-if="isRepositoryWorkspaceRoute"/);
  assert.match(app, /<AuthGate v-else>/);
  assert.match(workspace, /aria-label="Open repository workspace in new window"/);
  assert.match(workspace, /openRepositoryWorkspaceWindow\(\{ \.\.\.target\.value, view: sidebarView\.value \}\)/);
  assert.match(workspace, /Unsaved drafts remain in this window/);
  assert.match(workspace, /repositoryWorkspaceChannelName/);
  assert.match(workspace, /refreshRepositoryState\(\), refreshLoadedDirectories\(\)/);
  assert.match(page, /getRepositoryContext\(route\)/);
  assert.match(page, /standalone/);
  assert.match(windowHelper, /location\.pathname !== "\/repository-workspace"/);
  assert.match(windowHelper, /sessionKind !== "ai-session" && sessionKind !== "app-session"/);
  assert.match(windowHelper, /new URLSearchParams\(\{[\s\S]*instanceId:[\s\S]*sessionKind:[\s\S]*sessionId:[\s\S]*view:/);
  assert.doesNotMatch(windowHelper, /snapshotId|displayName|RepositoryContext/);
});

test("Repository file actions preserve drafts on stale and require an explicit comparison before retry", async () => {
  const [workspace, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(workspace, /Open working file/);
  assert.match(workspace, /New repository file/);
  assert.match(workspace, /Rename repository file/);
  assert.match(workspace, /Delete repository file\?/);
  assert.match(workspace, /confirm: true/);
  assert.match(workspace, /const draft = tab\.draft;[\s\S]*tab\.draft = draft;[\s\S]*tab\.staleServer = server/);
  assert.match(workspace, /Compare versions/);
  assert.match(workspace, /:disabled="!activeTab\.staleCompared \|\| activeTab\.saving"/);
  assert.match(workspace, /saveFile\(tab, tab\.staleServer\.version\)/);
  assert.doesNotMatch(workspace, /staleServer\.content[\s\S]{0,80}tab\.draft\s*=/);
  assert.match(repositoryApi, /postUrlData<RepositoryFileMutationResult>\(`\$\{repositoryTargetBasePath\(target\)\}\/files`/);
  assert.match(repositoryApi, /putUrlData<RepositoryFileMutationResult>/);
  assert.match(repositoryApi, /\/files\/rename/);
  assert.match(repositoryApi, /deleteUrlData<RepositoryFileMutationResult>/);
});

test("Changes mutations use selected path versions, explicit discard confirmation, and the server result", async () => {
  const [workspace, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(workspace, /expectedVersion: entry\.version/);
  assert.match(workspace, /stageRepositoryPaths\(target\.value/);
  assert.match(workspace, /unstageRepositoryPaths\(target\.value/);
  assert.match(workspace, /Discard worktree changes/);
  assert.match(workspace, /Existing staged content is retained/);
  assert.match(workspace, /Discard all tracked changes/);
  assert.match(workspace, /index and worktree content from HEAD/);
  assert.match(workspace, /confirm: true/);
  assert.match(workspace, /This does not delete untracked files or create a stash/);
  assert.match(workspace, /This commits the current index only/);
  assert.match(workspace, /commitRepositoryIndex\(target\.value, \{ message: commitMessage\.value, expectedSnapshotId: requireSnapshotId\(\) \}\)/);
  assert.match(workspace, /changes\.value = result\.changes/);
  assert.match(workspace, /queryClient\.setQueryData\(repositoryContextQueryKey\(\), result\.context\)/);
  assert.doesNotMatch(workspace, /commitIndex[\s\S]{0,1000}stageRepositoryPaths/);
  assert.match(repositoryApi, /"index\/stage"/);
  assert.match(repositoryApi, /"index\/unstage"/);
  assert.match(repositoryApi, /"discard\/worktree"/);
  assert.match(repositoryApi, /"discard\/all-tracked"/);
  assert.match(repositoryApi, /"commits"/);
});

test("Repository delivery follows the server primary action and uses explicit non-force operations", async () => {
  const [environment, delivery, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryDeliveryDialog.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(environment, /runPrimaryAction\(context\.primaryAction\)/);
  assert.match(environment, /deliveryOpen\.value = true/);
  assert.match(delivery, /context\.primaryAction === 'publish-branch'/);
  assert.match(delivery, /context\.primaryAction === 'push'/);
  assert.match(delivery, /context\.primaryAction === 'pull'/);
  assert.match(delivery, /context\.primaryAction === 'diverged'/);
  assert.match(delivery, /context\.primaryAction === 'up-to-date'/);
  assert.match(delivery, /confirmSetUpstream: true as const/);
  assert.match(delivery, /Push uses an explicit refspec and never uses force/);
  assert.match(delivery, /Fast-forward only/);
  assert.match(delivery, /No merge commit or rebase will be created/);
  assert.match(delivery, /Resolve it in the session terminal/);
  assert.match(delivery, /fetchRepositoryRemote/);
  assert.match(delivery, /queryClient\.setQueryData\(\["repository-context"/);
  assert.match(delivery, /<RepositoryErrorNotice v-if="errorCause"/);
  assert.doesNotMatch(`${delivery}\n${repositoryApi}`, /\bforce\s*:/);
  assert.match(repositoryApi, /mutateRepositoryDelivery\(target, "fetch"/);
  assert.match(repositoryApi, /mutateRepositoryDelivery\(target, "pull"/);
  assert.match(repositoryApi, /mutateRepositoryDelivery\(target, "publish"/);
  assert.match(repositoryApi, /mutateRepositoryDelivery\(target, "push"/);
});

test("Repository UI preserves edge states and structured recovery guidance", async () => {
  const [environment, worktrees, workspace, delivery, errorNotice, errorPresentation, apiClient] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryDeliveryDialog.vue"),
    source("apps/control-plane/instance-detail/RepositoryErrorNotice.vue"),
    source("apps/control-plane/instance-detail/repositoryErrorPresentation.ts"),
    source("api/client.ts"),
  ]);

  for (const availability of ["session-not-found", "session-inactive", "cwd-missing", "cwd-inaccessible", "git-unavailable", "not-worktree"]) {
    assert.match(environment, new RegExp(`"${availability}"`));
  }
  assert.match(environment, /connectionStatus !== 'online'/);
  assert.match(environment, /Detached HEAD at/);
  assert.match(environment, /Unborn branch with no commit yet/);
  assert.match(worktrees, /session-occupied/);
  assert.match(worktrees, /Prunable worktree record/);
  assert.match(workspace, /Resolve conflicts before commit, pull, or push/);
  assert.match(workspace, /Binary diff cannot be displayed/);
  assert.match(workspace, /Only the first \{\{ activeTab\.byteLimit \}\} bytes are shown/);
  assert.match(workspace, /Inspect the complete patch in the session terminal/);
  assert.match(delivery, /Credentials are never entered in this UI|RepositoryErrorNotice/);
  assert.match(workspace, /repository-file-action-dialog[^}]*background: hsl\(var\(--background\)\)/);
  assert.match(delivery, /repository-delivery-dialog[^}]*background: hsl\(var\(--background\)\)/);
  assert.doesNotMatch(`${workspace}\n${delivery}`, /background: var\(--background\)/);
  assert.match(errorNotice, /presentation\.code/);
  assert.match(errorNotice, /presentation\.recovery/);
  assert.match(errorNotice, /presentation\.retryable/);
  for (const code of [
    "REPOSITORY_STATE_STALE",
    "REPOSITORY_WORKTREE_OCCUPIED",
    "REPOSITORY_CONFLICT",
    "REPOSITORY_AUTHENTICATION_FAILED",
    "REPOSITORY_NON_FAST_FORWARD",
    "REPOSITORY_OUTPUT_LIMIT",
  ]) assert.match(errorPresentation, new RegExp(code));
  assert.match(errorPresentation, /error instanceof ApiError/);
  assert.match(apiClient, /payload\.error\?\.retryable/);
});

test("Repository navigation keeps portal, keyboard, focus, draft, path, and confirmation contracts", async () => {
  const [environment, workspace, worktrees, popoverContent, dialogContent, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("components/ui/popover/PopoverContent.vue"),
    source("components/ui/dialog/DialogContent.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(popoverContent, /PopoverPortal/);
  assert.match(dialogContent, /DialogPortal/);
  assert.doesNotMatch(environment, /@open-auto-focus\.prevent/);
  assert.match(workspace, /@open-auto-focus="focusWorkspace"/);
  assert.match(workspace, /DialogTitle v-if="!embedded" class="sr-only"/);
  assert.match(workspace, /DialogDescription v-if="!embedded" class="sr-only"/);
  assert.match(workspace, /role="tablist"[\s\S]*@keydown="navigateSidebarTabs"/);
  assert.match(workspace, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(workspace, /:tabindex="sidebarView === 'files' \? 0 : -1"/);
  assert.match(workspace, /:tabindex="activeTabId === tab\.id \? 0 : -1"/);
  assert.match(workspace, /class="repository-workspace-tab-close" :aria-label="`Close \$\{tab\.path\}`"/);
  assert.doesNotMatch(workspace, /<button[^>]*role="tab"[\s\S]{0,500}<X[^>]*role="button"/);

  assert.match(repositoryApi, /new URLSearchParams/);
  assert.match(repositoryApi, /encodeURIComponent\(target\.sessionId\)/);
  assert.doesNotMatch(repositoryApi, /\?path=\$\{/);
  assert.match(workspace, /const id = `file:\$\{entry\.path\}`/);
  assert.match(workspace, /const id = `diff:\$\{entry\.scope\}:\$\{entry\.path\}`/);
  assert.match(workspace, /const draft = tab\.draft;[\s\S]*tab\.draft = draft/);
  assert.match(workspace, /tabs\.value\.push\(\{ \.\.\.file, id, kind: "file", draft: file\.content/);

  assert.match(worktrees, /workspaceSelection:[\s\S]*repositoryContextId:[\s\S]*worktreeId:/);
  assert.match(worktrees, /The current session stays in this worktree/);
  assert.match(workspace, /confirm: true/);
  assert.match(workspace, /data-discard-cancel/);
  assert.match(workspace, /This commits the current index only/);
});
