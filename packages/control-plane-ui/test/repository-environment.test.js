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
  assert.match(component, /context\.primaryAction !== 'review-changes' && context\.primaryAction !== 'resolve-conflicts'/);
  assert.match(component, /repository\.environment\.filesChanges/);
  assert.match(component, /repository\.environment\.worktree/);
  assert.match(component, /repository\.environment\.branch/);
  assert.match(component, /\.repository-environment-trigger-detail \{[^}]*color: var\(--text-muted\);/);
  assert.match(component, /\.repository-environment-trigger-branch \{[^}]*color: inherit;/);
  assert.doesNotMatch(component, /executionLocation|<Laptop/);
  assert.match(repositoryApi, /\/instances\/\$\{encodeURIComponent\(target\.instanceId\)\}\/api\/\$\{sessionCollection\}\/\$\{encodeURIComponent\(target\.sessionId\)\}\/repository/);
  assert.match(repositoryApi, /safeParseResponse\(RepositoryWorktreesSchema/);
  assert.match(repositoryApi, /Restart the instance to load the current protocol/);
  const contextClient = repositoryApi.slice(repositoryApi.indexOf("export function getRepositoryContext"), repositoryApi.indexOf("export function getRepositoryWorktrees"));
  assert.doesNotMatch(contextClient, /[?&](cwd|path|repositoryRoot)=/);
});

test("Worktrees use opaque server ids and expose AI-session creation without cwd switching", async () => {
  const [environment, panel, tab, pane, sessions, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesTab.vue"),
    source("apps/control-plane/instance-detail/SessionPaneContent.vue"),
    source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts"),
    source("api/repository.ts"),
  ]);

  assert.match(environment, /page: "worktrees"/);
  assert.doesNotMatch(environment, /repository-worktrees-popover/);
  assert.match(tab, /<RepositoryWorktreesPanel/);
  assert.match(tab, /class="repository-worktrees-tab-surface"/);
  assert.match(pane, /session\.source\?\.page === 'worktrees'/);
  assert.match(sessions, /repository-worktrees:/);
  assert.match(sessions, /repository\.worktreesPanel\.title/);
  assert.match(panel, /repository\.worktreesPanel\.current/);
  assert.match(panel, /repository\.worktreesPanel\.managed/);
  assert.match(panel, /repository\.worktreesPanel\.dirty/);
  assert.match(panel, /repository\.worktreesPanel\.locked/);
  assert.match(panel, /repository\.environmentExtra\.associatedSessions/);
  assert.match(panel, /<DropdownMenuContent class="repository-worktree-menu"/);
  assert.match(panel, /repository\.worktreesPanel\.newHere/);
  assert.match(panel, /repository\.worktreesPanel\.search/);
  assert.match(panel, /filteredWorktrees/);
  assert.match(panel, /<ScrollArea/);
  assert.match(panel, /<strong :title="worktreeLabel\(worktree\)">/);
  assert.match(panel, /\.repository-worktree-title \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap/);
  assert.match(panel, /\.repository-worktree-title strong \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap/);
  assert.match(environment, /class="repository-environment-branch-summary" :title="branchSummary"/);
  assert.match(environment, /\.repository-environment-branch-summary \{[\s\S]*white-space: nowrap/);
  assert.match(panel, /repositoryContextId: worktrees\.value\.repositoryContextId/);
  assert.match(panel, /worktreeId: worktree\.id/);
  assert.doesNotMatch(panel, /workspaceSelection:[\s\S]*\b(cwd|path)\s*:/);
  assert.match(repositoryApi, /target\.sessionKind !== "ai-session"/);
});

test("managed worktree creation reuses the shared dialog without starting an AI session", async () => {
  const [panel, dialog, worktreesTab, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("apps/control-plane/instance-detail/NewWorktreeDialog.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesTab.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(panel, /<NewWorktreeDialog/);
  assert.match(panel, /createRepositoryWorkspaceWorktree\(target\.value, \{ \.\.\.selection, expectedSnapshotId: worktrees\.value\.snapshotId \}\)/);
  assert.match(dialog, /sessions\.panel\.newWorktreeDescription/);
  assert.match(dialog, /value="existing-branch"/);
  assert.match(dialog, /value="new-branch"/);
  assert.doesNotMatch(panel, /createMessage|createRepositoryWorktreeAiSession/);
  assert.match(panel, /\.repository-worktree-directory \{[\s\S]*border: 1px solid var\(--line\);[\s\S]*background: var\(--surface-raised\)/);
  assert.match(panel, /\.repository-worktree-list \{[\s\S]*display: grid;/);
  assert.match(panel, /\.repository-worktree-row \+ \.repository-worktree-row \{[\s\S]*border-top: 1px solid var\(--line\)/);
  assert.match(panel, /\.repository-worktree-row\[data-current="true"\] \.repository-worktree-title strong \{[\s\S]*color: var\(--repository-current-text, var\(--brand-accent-muted, var\(--brand-accent\)\)\)/);
  assert.match(repositoryApi, /repositoryWorkspaceResource\(target, "worktrees"\)/);
  assert.doesNotMatch(panel, /worktree:\s*\{[^}]*\b(path|cwd)\s*:/);
  assert.match(worktreesTab, /props\.session\.source\?\.aiAgent/);
  assert.match(worktreesTab, /agent === "codex" \|\| agent === "claude"/);
});

test("worktree rows align identity, state summary, and actions as separate columns", async () => {
  const panel = await source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue");

  assert.match(panel, /\.repository-worktree-row \{[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(0, 1\.35fr\) minmax\(190px, 1fr\) auto;/);
  assert.match(panel, /<div class="repository-worktree-identity">[\s\S]*<div class="repository-worktree-copy">[\s\S]*<div class="repository-worktree-summary">[\s\S]*<div class="repository-worktree-row-actions">/);
  assert.match(panel, /<div class="repository-worktree-title">[\s\S]*<strong :title="worktreeLabel\(worktree\)">[\s\S]*<Badge variant="secondary">\{\{ worktreeKindLabel\(worktree\) \}\}<\/Badge>[\s\S]*<code v-if="worktreeCommit\(worktree\)"/);

  const identity = panel.slice(panel.indexOf('<div class="repository-worktree-identity">'), panel.indexOf('<div class="repository-worktree-summary">'));
  assert.doesNotMatch(identity, /worktreesPanel\.(dirty|locked|prunable)/);
  for (const state of ["dirty", "locked", "prunable"]) {
    assert.match(panel, new RegExp(`class="repository-worktree-summary-item"[^>]*>[\\s\\S]*?repository\\.worktreesPanel\\.${state}`));
  }
  assert.match(panel, /<span v-if="activeSessionCount\(worktree\)" class="repository-worktree-summary-item">[\s\S]*repository\.environmentExtra\.associatedSessions/);

  assert.match(panel, /\.repository-worktree-summary \{[\s\S]*?display: grid;[\s\S]*?gap: 5px;/);
  assert.match(panel, /\.repository-worktree-summary-item \{[\s\S]*?display: flex;[\s\S]*?font-size: 12px;/);
  assert.match(panel, /\.repository-worktree-summary-item\[data-state="warning"\] \{[\s\S]*?color: var\(--status-warning\);/);
  assert.match(panel, /\.repository-worktree-warning \{[\s\S]*grid-column: 1 \/ -1;/);
  assert.match(panel, /\.repository-worktree-start-composer \{[\s\S]*grid-column: 1 \/ -1;/);
  assert.match(panel, /@container repository-worktrees \(max-width: 720px\) \{[\s\S]*\.repository-worktree-summary \{[\s\S]*grid-column: 1 \/ -1;/);
  assert.doesNotMatch(panel, /@media \(max-width: 720px\)/);
});

test("new-session worktree dialog restores branch selection and detached checkout semantics", async () => {
  const [panel, dialog, branchPicker] = await Promise.all([
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("apps/control-plane/instance-detail/NewWorktreeDialog.vue"),
    source("apps/control-plane/instance-detail/NewWorktreeBranchPicker.vue"),
  ]);

  assert.match(panel, /<NewWorktreeDialog/);
  assert.match(dialog, /ToggleGroupItem value="existing-branch"/);
  assert.match(dialog, /ToggleGroupItem value="new-branch"/);
  assert.match(dialog, /id="new-worktree-existing-branch"[\s\S]*v-model="branchName"[\s\S]*selectable-only/);
  assert.match(dialog, /id="new-worktree-start-ref"[\s\S]*v-model="startRef"[\s\S]*:branches="branches"/);
  assert.match(branchPicker, /\(!props\.selectableOnly \|\| branch\.worktreeSelectable\)/);
  assert.match(branchPicker, /showDetached && node\.branch\.worktreeCheckout === 'detached'/);
  assert.match(dialog, /newWorktreeDetachedDescription/);
  assert.match(panel, /\{ mode: "worktree", branch: newSessionManagedWorktreeBranch\.value \}/);
  assert.match(panel, /\|\| newSessionManagedWorktreeBranch\.value[\s\S]*\? undefined/);
  assert.match(panel, /createRepositoryWorkspaceWorktree\([\s\S]*newSessionWorktreeId\.value = created\.worktreeId/);
  assert.match(panel, /Compatibility for v0\.0\.21:[\s\S]*error instanceof ApiError && error\.status === 404[\s\S]*newSessionCreateNewWorktree\.value = selection\.mode === "new-branch"/);
});

test("managed worktree removal is workspace-scoped, confirmed, non-force, and retains the branch", async () => {
  const [panel, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(panel, /canManageWorktrees = computed\(\(\) => true\)/);
  assert.match(panel, /removeRepositoryWorkspaceWorktree\(target\.value/);
  assert.match(panel, /repository\.worktreeRemoveDescription/);
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
  assert.match(panel, /repository\.branchesPanel\.search/);
  assert.match(panel, /repository\.branchesPanel\.remote/);
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
  assert.match(panel, /repository\.branchesPanel\.deleteDescription/);
  assert.match(panel, /queryClient\.setQueryData\(\["repository-context"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "checkout"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "tracking"/);
  assert.match(repositoryApi, /mutateRepositoryBranches\(target, "delete"/);
  assert.doesNotMatch(`${panel}\n${repositoryApi}`, /\bforce\s*:/);
});

test("Repository workspace opens as a session tab with a floating searchable file tree", async () => {
  const [environment, workspace, workspaceFileList, workspaceTab, sessionState, tree, picker, repositoryApi, fileEditor, sourceLanguage] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspaceFileList.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspaceTab.vue"),
    source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts"),
    source("apps/control-plane/instance-detail/RepositoryFileTree.vue"),
    source("apps/control-plane/instance-detail/RepositoryFilePicker.vue"),
    source("api/repository.ts"),
    source("apps/control-plane/instance-detail/RepositoryFilePreview.vue"),
    source("components/source-code/sourceLanguage.ts"),
  ]);

  assert.match(environment, /function repositoryWorkspaceTarget\(extra: Omit<RepositoryWorkspaceTabTarget, "cwdFolderId" \| "sessionId" \| "sessionKind">\) \{[\s\S]*\.\.\.\(props\.cwdFolderId \? \{ cwdFolderId: props\.cwdFolderId \} : \{\}\)/);
  assert.match(environment, /emit\("openWorkspace", repositoryWorkspaceTarget\(\{ initialView: view \}\)\)/);
  assert.match(environment, /emit\("openWorkspace", repositoryWorkspaceTarget\(\{\s*aiAgent: props\.aiAgent,[\s\S]*page: "worktrees",/);
  assert.match(workspaceTab, /<RepositoryWorkspace[\s\S]*:context="contextQuery\.data\.value"/);
  assert.match(workspaceTab, /@open-changes="openWorkspaceFromPane"/);
  assert.match(workspaceTab, /function openWorkspaceFromPane\(target: \{[\s\S]*\.\.\.\(cwdFolderId\.value \? \{ cwdFolderId: cwdFolderId\.value \} : \{\}\)/);
  assert.doesNotMatch(workspaceTab, /dialogOpen|open-dialog|open-tab/);
  assert.doesNotMatch(workspace, /repository\.workspace\.(?:openDialog|returnTab|openWindow)/);
  assert.match(sessionState, /kind: "repository"/);
  assert.match(sessionState, /function openRepositoryWorkspace\(target: RepositoryWorkspaceTabTarget\)/);
  assert.match(workspace, /RepositoryFileTree/);
  assert.match(workspace, /<RepositoryFilePicker/);
  assert.match(workspace, /class="repository-workspace-path"/);
  assert.match(workspace, /v-for="\(segment, index\) in breadcrumbSegments"[\s\S]*:open="openBreadcrumbIndex === index"/);
  assert.match(workspace, /<ChevronRight\s+v-if="index"/);
  assert.match(workspace, /updateBreadcrumbPicker\(index, segment, \$event\)/);
  assert.match(workspace, /@wheel="scrollBreadcrumb"/);
  assert.match(workspace, /element\.scrollLeft \+= event\.deltaY/);
  assert.match(workspace, /scrollbar-width: none/);
  assert.match(workspace, /data-collapsed/);
  assert.match(workspace, /:data-picker-open="openBreadcrumbIndex === undefined \? undefined : 'true'"/);
  assert.match(workspace, /:data-expanded="breadcrumbExpanded \? 'true' : undefined"/);
  assert.match(workspace, /@mouseenter="setBreadcrumbExpanded\(true\)"/);
  assert.match(workspace, /@mouseleave="setBreadcrumbExpanded\(false\)"/);
  assert.match(workspace, /@focusin="setBreadcrumbExpanded\(true\)"/);
  assert.match(workspace, /function setBreadcrumbExpanded\(next: boolean\)/);
  assert.match(workspace, /repository-workspace-path\[data-expanded\] \.repository-workspace-path-segment\[data-collapsed="true"\]/);
  assert.doesNotMatch(workspace, /repository-workspace-path:hover/);
  assert.doesNotMatch(workspace, /:has\(\.repository-workspace-path-segment:focus-visible\)/);
  assert.match(workspace, /function updateBreadcrumbCollapse\(\) \{/);
  assert.match(workspace, /measureBreadcrumbLabel/);
  assert.match(workspace, /const fullWidth = widths\.reduce\(\(total, width\) => total \+ width, 0\) \+ lastIndex \* BREADCRUMB_SEPARATOR_WIDTH;/);
  assert.match(workspace, /if \(nextWidth \+ tailWidth > available\) break;/);
  assert.match(workspace, /function isCollapsedBreadcrumb\(index: number\) \{[\s\S]*?index >= first && index < breadcrumbSegments\.value\.length - 1/);
  assert.match(workspace, /:data-collapsed-first="isCollapsedBreadcrumbFirst\(index\) \? 'true' : undefined"/);
  assert.match(workspace, /\[data-collapsed="true"\]\[data-collapsed-first="true"\]::after \{ content: "\.\.\.";/);
  assert.match(workspace, /\.repository-workspace-path:not\(\[data-expanded\]\):not\(\[data-picker-open\]\) \.repository-workspace-path-segment\[data-current="true"\] \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  const expandedBreadcrumbRule = workspace.match(/\[data-picker-open\] \.repository-workspace-path-segment\[data-collapsed="true"\],[\s\S]*?\{([^}]*)\}/);
  assert.ok(expandedBreadcrumbRule, "collapsed breadcrumb group must expand on hover");
  assert.doesNotMatch(expandedBreadcrumbRule[1], /background/);
  assert.match(workspace, /searchRepositoryPaths\(target\.value, query, 100/);
  assert.match(workspace, /function flattenLoadedDirectories/);
  assert.match(workspace, /function revealDirectory/);
  assert.doesNotMatch(workspace, /repository-workspace-sidebar|startSidebarResize|sidebarWidth/);
  assert.match(picker, /<Popover[\s\S]*<ScrollArea type="always" :horizontal="false"/);
  assert.match(picker, /--reka-popover-content-available-height/);
  assert.match(workspaceFileList, /repository\.workspace\.explorer/);
  assert.match(workspace, /@click="openChangesReview"/);
  assert.match(workspace, /emit\("openChanges", \{ initialView: "changes", page: "changes-review"/);
  assert.match(workspace, /<RepositoryFilePreview :content="activeTab\.content" :line="activeTab\.line" :path="activeTab\.path"/);
  assert.doesNotMatch(workspace, /<textarea|writeRepositoryFile|saveFile\(|activeTab\.draft/);
  assert.match(fileEditor, /highlightSource\(props\.content, language\.value\)/);
  assert.match(fileEditor, /<ScrollArea ref="previewRoot" type="always" class="repository-file-preview-scroll">/);
  assert.match(fileEditor, /data-task-handoff-scroll-viewport/);
  assert.match(fileEditor, /viewport\.scrollTop/);
  assert.match(fileEditor, /repository-file-preview-scroll :deep\(\[data-task-handoff-scroll-viewport\]/);
  assert.match(fileEditor, /<div class="repository-file-preview-gutter" aria-hidden="true">/);
  assert.match(fileEditor, /repository-file-preview-gutter-numbers/);
  assert.match(fileEditor, /const lineNumbers = computed\(\(\) => \{/);
  assert.match(fileEditor, /function lineNumberSequence\(from: number, to: number\)/);
  assert.match(fileEditor, /function measureLineHeight\(\) \{[\s\S]*?gutterLines\.value\?\.getBoundingClientRect\(\)\.height[\s\S]*?height \/ lineCount\.value/);
  assert.match(fileEditor, /\.repository-file-preview-gutter-lines \{ display: block; \}/);
  assert.match(fileEditor, /\.repository-file-preview-gutter \{[^}]*position: sticky;[^}]*left: 0;[^}]*\}/);
  assert.match(fileEditor, /\.repository-file-preview-gutter-numbers \{[^}]*display: block; white-space: pre;/);
  assert.match(fileEditor, /\.repository-file-preview-scroll :deep\(\[data-task-handoff-scroll-viewport\] > div\) \{[^}]*display: flex;/);
  assert.match(sourceLanguage, /tsx: "typescript"/);
  assert.doesNotMatch(workspace, /stageRepositoryPaths|unstageRepositoryPaths|discardRepositoryWorktree|commitRepositoryIndex/);
  assert.doesNotMatch(workspace, /repository-workspace-tabs|role="tablist"|data-repository-tab/);
  assert.doesNotMatch(workspace, /repository-workspace-editor > header/);
  assert.match(workspace, /\.repository-workspace-content \{[^}]*width: 100%;[^}]*height: 100%;/);
  assert.match(workspace, /\.repository-workspace-main \{[^}]*grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(tree, /export type RepositoryFileTreeNode/);
  assert.match(tree, /emit\("toggle", node\)/);
  assert.match(repositoryApi, /getRepositoryDirectory/);
  assert.match(repositoryApi, /getRepositoryFile/);
  assert.match(repositoryApi, /searchRepositoryPaths/);
  assert.match(repositoryApi, /getRepositoryDiff/);
});

test("Repository file and directory failures preserve the file tree", async () => {
  const [workspace, fileList] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspaceFileList.vue"),
  ]);
  const openFile = workspace.slice(workspace.indexOf("async function openFile"), workspace.indexOf("watch(\n  [() => props.initialFileRequestId"));
  const toggleDirectory = workspace.slice(workspace.indexOf("async function toggleDirectory"), workspace.indexOf("async function openFile"));

  assert.match(fileList, /<RepositoryErrorNotice v-else-if="workspaceLoadError"/);
  assert.match(fileList, /<template v-else>[\s\S]*directoryLoadError[\s\S]*<RepositoryFileTree/);
  assert.match(workspace, /currentFilePath = computed\(\(\) => activeTab\.value\?\.path \|\| fileOpenError\.value\?\.path/);
  assert.match(workspace, /<section v-if="fileOpenError" class="repository-workspace-editor repository-workspace-file-error">[\s\S]*RepositoryErrorNotice/);
  assert.doesNotMatch(workspace, /repository-workspace-file-error">\s*<header/);
  assert.match(workspace, /<section v-else-if="activeTab" class="repository-workspace-editor">/);
  assert.match(openFile, /fileOpenError\.value = \{ path: entry\.path, error \}/);
  assert.doesNotMatch(openFile, /workspaceLoadError/);
  assert.match(toggleDirectory, /directoryLoadError\.value = \{ path: entry\.path, error \}/);
  assert.doesNotMatch(toggleDirectory, /workspaceLoadError/);
});

test("Repository workspace is tab-only and has no independent-window route", async () => {
  const [app, workspace] = await Promise.all([
    source("App.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
  ]);

  assert.doesNotMatch(app, /RepositoryWorkspacePage|isRepositoryWorkspaceRoute|repository-workspace/);
  assert.doesNotMatch(workspace, /openInNewWindow|openRepositoryWorkspaceWindow|repository\.workspace\.openWindow/);
  assert.doesNotMatch(workspace, /Unsaved drafts remain in this window/);
  assert.doesNotMatch(workspace, /BroadcastChannel|repositoryInvalidationChannelName/);
  assert.match(workspace, /watch\(\(\) => `\$\{props\.instanceId\}:\$\{props\.sessionKind\}:\$\{props\.sessionId\}`,[\s\S]*\{ immediate: true \}\)/);
  assert.doesNotMatch(workspace, /standalone|embedded\?|open: boolean/);
});

test("Repository file actions keep previews read-only and refresh stale server content", async () => {
  const [workspace, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(workspace, /repository\.workspace\.newFileTitle/);
  assert.match(workspace, /repository\.workspace\.renameTitle/);
  assert.match(workspace, /repository\.workspace\.deleteTitle/);
  assert.match(workspace, /confirm: true/);
  assert.match(workspace, /refreshOpenFiles\(\)/);
  assert.match(workspace, /Object\.assign\(tab, await getRepositoryFile\(target\.value, tab\.path\)\)/);
  assert.doesNotMatch(workspace, /draft|staleServer|writeRepositoryFile/);
  assert.match(repositoryApi, /postUrlData<RepositoryFileMutationResult>\(`\$\{repositoryTargetBasePath\(target\)\}\/files`/);
  assert.match(repositoryApi, /putUrlData<RepositoryFileMutationResult>/);
  assert.match(repositoryApi, /\/files\/rename/);
  assert.match(repositoryApi, /deleteUrlData<RepositoryFileMutationResult>/);
});

test("Changes review owns versioned stage, unstage, and discard mutations", async () => {
  const [review, workspace, repositoryApi] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryChangesReviewTab.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("api/repository.ts"),
  ]);

  assert.match(review, /expectedVersion: entry\.version/);
  assert.match(review, /stageRepositoryPaths\(target\.value/);
  assert.match(review, /unstageRepositoryPaths\(target\.value/);
  assert.match(review, /discardRepositoryWorktree\(target\.value/);
  assert.match(review, /confirm: true/);
  assert.match(review, /if \(result\.changes\) changes\.value = result\.changes/);
  assert.match(review, /queryClient\.setQueryData\(\["repository-context"/);
  assert.doesNotMatch(workspace, /stageRepositoryPaths|unstageRepositoryPaths|discardRepositoryWorktree|commitRepositoryIndex/);
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
  assert.match(delivery, /repository\.delivery\.explicitRefspec/);
  assert.match(delivery, /repository\.delivery\.ffOnly/);
  assert.match(delivery, /repository\.delivery\.noMerge/);
  assert.match(delivery, /repository\.delivery\.divergedHint/);
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
  const [environment, worktrees, workspace, reviewCard, delivery, errorNotice, errorPresentation, apiClient] = await Promise.all([
    source("apps/control-plane/instance-detail/RepositoryEnvironment.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorktreesPanel.vue"),
    source("apps/control-plane/instance-detail/RepositoryWorkspace.vue"),
    source("apps/control-plane/instance-detail/RepositoryChangeDiffCard.vue"),
    source("apps/control-plane/instance-detail/RepositoryDeliveryDialog.vue"),
    source("apps/control-plane/instance-detail/RepositoryErrorNotice.vue"),
    source("apps/control-plane/instance-detail/repositoryErrorPresentation.ts"),
    source("api/client.ts"),
  ]);

  for (const availability of ["session-not-found", "session-inactive", "cwd-missing", "cwd-inaccessible", "git-unavailable", "not-worktree"]) {
    assert.match(environment, new RegExp(`"${availability}"`));
  }
  assert.match(environment, /connectionStatus !== 'online'/);
  assert.match(environment, /repository\.environment\.detachedNotice/);
  assert.match(environment, /repository\.environment\.unbornNotice/);
  assert.match(worktrees, /session-occupied/);
  assert.match(worktrees, /repository\.worktreesPanel\.blockers\.prunable/);
  assert.match(reviewCard, /repository\.diff\.binary/);
  assert.match(reviewCard, /repository\.diff\.binaryHint/);
  assert.match(reviewCard, /repository\.diff\.truncatedBytes/);
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

test("Repository navigation keeps portal, breadcrumb path, and confirmation contracts", async () => {
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
  assert.match(workspace, /<template #trigger>[\s\S]*<button[\s\S]*class="repository-workspace-path-segment"/);
  assert.match(workspace, /const breadcrumbSegments = computed/);
  assert.match(workspace, /tabindex="-1"/);
  assert.doesNotMatch(workspace, /role="tablist"|navigateOpenTabs|repository-workspace-tab-close/);

  assert.match(repositoryApi, /new URLSearchParams/);
  assert.match(repositoryApi, /encodeURIComponent\(target\.sessionId\)/);
  assert.doesNotMatch(repositoryApi, /\?path=\$\{/);
  assert.match(workspace, /const id = `file:\$\{entry\.path\}`/);
  assert.doesNotMatch(workspace, /const id = `diff:|getRepositoryDiff/);
  assert.match(workspace, /tabs\.value\.push\(\{ \.\.\.file, id, kind: "file" \}\)/);
  assert.match(workspace, /<RepositoryFilePreview :content="activeTab\.content"/);

  assert.match(worktrees, /workspaceSelection:[\s\S]*repositoryContextId:[\s\S]*worktreeId:/);
  assert.match(worktrees, /<NewWorktreeDialog/);
  assert.match(workspace, /confirm: true/);
  assert.doesNotMatch(workspace, /data-discard-cancel|This commits the current index only/);
});
