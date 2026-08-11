import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const boardCard = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const sharedActionStyles = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardAction.css", import.meta.url), "utf8");
const contextMenu = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardContextMenu.vue", import.meta.url), "utf8");
const originMark = fs.readFileSync(new URL("../src/components/ai-session/AiSessionOriginMark.vue", import.meta.url), "utf8");
const contextSubMenu = fs.readFileSync(new URL("../src/components/ui/context-menu/ContextMenuSubContent.vue", import.meta.url), "utf8");
const scrollArea = fs.readFileSync(new URL("../src/components/ui/scroll-area/ScrollArea.vue", import.meta.url), "utf8");

test("instance AI session cards match board card status and navigation behavior", () => {
  assert.doesNotMatch(panel, /<small>\{\{ aiSessionStatusLabel\(session\) \}\}<\/small>/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) <= 0"/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) >= promptCount\(session\) - 1"/);
  assert.match(panel, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(panel, /\(index \+ count\) % count/);
});

test("terminal-origin AI sessions show the same subtle marker in the panel and board", () => {
  assert.match(originMark, /v-if="creationSource === 'app-session'"/);
  assert.match(originMark, /<SquareTerminal :size="17"/);
  assert.match(originMark, /opacity: 0\.38;/);
  assert.match(panel, /<AiSessionOriginMark :creation-source="session\.creationSource"/);
  assert.match(boardCard, /<AiSessionOriginMark :creation-source="card\.session\.creationSource"/);
  assert.doesNotMatch(originMark, /appSessionId/);
});

test("AI session path labels show only the folder and reveal the full path when hovered", () => {
  assert.match(panel, /v-if="!groupSessionsByPath" class="session-ai-card-workspace"/);
  assert.match(panel, /class="session-ai-card-workspace">\s*<span aria-hidden="true">·<\/span>/);
  assert.match(panel, /aiSessionBasename\(session\.cwd\)/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<b>/);
  assert.match(panel, /<TooltipContent[^>]*>\{\{ session\.cwd \|\| t\("sessions\.board\.unknownPath"\) \}\}<\/TooltipContent>/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<span class="session-ai-path-group-title">/);
  assert.match(styles, /\.session-ai-card-workspace b\s*\{[^}]*color: inherit;[^}]*font-weight: inherit;/s);
});

test("AI session path groups create a session in their registered project", () => {
  assert.doesNotMatch(panel, /group\.(?:sessions|items)\.length/);
  assert.match(panel, /session\.cwdFolderId \? `folder:\$\{session\.cwdFolderId\}` : `cwd:\$\{path\}`/);
  assert.match(panel, /item\.cwdFolderId \? `folder:\$\{item\.cwdFolderId\}` : `cwd:\$\{path\}`/);
  assert.match(panel, /class="session-ai-path-group-add"[\s\S]*?@click="openNewSessionForGroup\(group\)"/);
  assert.match(panel, /group\.cwdFolderId && newSessionFolders\.value\.some/);
  assert.match(panel, /newSessionFolderId\.value = group\.cwdFolderId;/);
  assert.match(panel, /const folderId = newSessionFolderIdForPath\(sessionPath\);/);
  assert.match(panel, /openNewSession\(\);\s*newSessionFolderId\.value = folderId;/);
  assert.match(styles, /\.session-ai-path-group-head\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 28px;/s);
  assert.match(styles, /\.session-ai-path-group-head:hover,\s*\.session-ai-path-group-head:focus-within\s*\{[^}]*background: var\(--surface-hover\);/s);
  assert.match(styles, /\.session-ai-path-group-add\s*\{[^}]*background: transparent;[^}]*opacity: 0;[^}]*visibility: hidden;/s);
  assert.match(styles, /\.session-ai-path-group-head:hover \.session-ai-path-group-add,\s*\.session-ai-path-group-head:focus-within \.session-ai-path-group-add\s*\{[^}]*opacity: 1;[^}]*visibility: visible;/s);
});

test("instance AI session card user messages use a single unpadded line", () => {
  assert.match(styles, /\.session-ai-preview-field-user\s*\{[^}]*max-height: 18px;[^}]*padding-block: 0;/s);
  assert.match(styles, /\.session-ai-question\s*\{[^}]*-webkit-line-clamp: 1;/s);
  assert.doesNotMatch(styles, /\.session-ai-question\s*\{[^}]*font-weight:\s*800;/s);
  assert.match(styles, /\.session-ai-question :deep\(p\),\s*\.session-ai-message :deep\(p\)\s*\{\s*margin: 0;/s);
});

test("instance AI session cards replace the metadata footer with floating navigation", () => {
  assert.doesNotMatch(panel, /aiSessionContext/);
  assert.doesNotMatch(panel, /session-ai-card-meta/);
  assert.match(styles, /grid-template-rows: auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.session-ai-select\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(styles, /\.session-ai-preview-field-assistant\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(styles, /\.session-ai-turn-nav\s*\{[^}]*position: absolute;[^}]*right: 10px;[^}]*bottom: 8px;/s);
  assert.match(styles, /\.session-ai-turn-nav\s*\{[^}]*gap: 2px;[^}]*padding: 0;/s);
});

test("waiting approval actions float at the bottom left of instance AI session cards", () => {
  assert.match(panel, /<div v-if="canResolveApproval\(session\)" class="session-ai-card-approval-actions">[\s\S]*?resolveApproval\(session, 'allow'\)/);
  assert.match(styles, /\.session-ai-card-approval-actions\s*\{[^}]*position: absolute;[^}]*bottom: 8px;[^}]*left: 14px;/s);
  assert.match(panel, /async function resolveApproval\(session: AiSessionSummary, decision:/);
  assert.match(panel, /return isAiSessionApprovalPending\(session\)/);
  assert.doesNotMatch(panel, /actions\?\.approval/);
});

test("instance AI session card previews do not open an expanded overlay", () => {
  assert.doesNotMatch(panel, /expandedPreview|data-ai-preview-trigger|expandPrompt|expandMessage/);
  assert.doesNotMatch(styles, /session-ai-expanded|cursor: zoom-in/);
});

test("mobile AI sessions switch between the card list and one detail pane", () => {
  assert.match(panel, /class="session-ai-workspace" :data-mobile-pane="mobilePane"/);
  assert.match(panel, /function selectSession\(sessionId: string\) \{[\s\S]*mobilePane\.value = "detail";[\s\S]*emit\("selectAiSession"/);
  assert.match(panel, /class="session-ai-mobile-list-button"[\s\S]*@click="showMobileSessionList"/);
  assert.match(panel, /function showMobileSessionList\(\) \{\s*mobilePane\.value = "list";/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*data-mobile-pane="list"[^}]*> \.session-ai-detail[\s\S]*data-mobile-pane="detail"[^}]*> \.session-ai-sidebar[^{]*\{\s*display: none;/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-panel \{\s*padding: 8px;[\s\S]*data-mobile-pane="detail"\] \{\s*grid-template-rows: 28px minmax\(0, 1fr\);\s*row-gap: 2px;[\s\S]*\.session-ai-mobile-list-button \{[\s\S]*height: 28px;[\s\S]*margin: 0;/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-preview-field-assistant \{\s*padding-right: 38px;/);
  assert.doesNotMatch(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-select \{\s*padding-right: 38px;/);
  assert.doesNotMatch(styles, /grid-template-rows: minmax\(220px, 42vh\) minmax\(0, 1fr\)/);
});

test("all instance AI sessions expose the unified close menu", () => {
  assert.match(panel, /<DropdownMenu>[\s\S]*?t\('sessions\.actions\.moreFor', \{ agent: session\.agent \}\)[\s\S]*?t\("sessions\.actions\.closeSession"\)/);
  assert.match(panel, /await closeAiSession\(props\.instance\.id, session\.id, crypto\.randomUUID\(\)\);/);
  assert.match(panel, /stoppingAppSessionId === session\.id \? t\("sessions\.actions\.closingSession"\) : t\("sessions\.actions\.closeSession"\)/);
  assert.match(panel, /aiSessionAppTab\(instance, session\) \|\| session\.actions\?\.openApp/);
  assert.match(styles, /:global\(\.session-ai-card-menu\)/);
  assert.match(styles, /:global\(\.session-ai-card-menu-item\.danger\)/);
});

test("instance and board cards share one action button style", () => {
  for (const source of [panel, boardCard]) {
    assert.match(source, /trigger-button ai-session-card-action/);
    assert.match(source, /open ai-session-card-action/);
    assert.match(source, /more ai-session-card-action/);
    assert.match(source, /<style scoped src="\.\.\/\.\.\/\.\.\/components\/ai-session\/AiSessionCardAction\.css"><\/style>/);
  }
  assert.match(sharedActionStyles, /border: 1px solid var\(--ai-board-floating-border\)/);
  assert.match(sharedActionStyles, /background: var\(--ai-board-floating-bg\)/);
  assert.match(sharedActionStyles, /border-color: var\(--ai-board-floating-hover-border\)/);
  assert.match(styles, /\.session-ai-trigger-button\[data-bound="true"\] \{\s*border-color: var\(--ai-board-active-border\);\s*color: var\(--ai-board-active-text\);/);
  assert.doesNotMatch(styles, /\.session-ai-open\s*\{/);
});

test("instance and board AI session cards expose their toolbar actions from one shared context menu", () => {
  for (const source of [panel, boardCard]) {
    assert.match(source, /<ContextMenu(?:\s|>)/);
    assert.match(source, /<ContextMenuTrigger as-child>/);
    assert.match(source, /<AiSessionCardContextMenu/);
  }
  assert.match(contextMenu, /<ContextMenuSubTrigger class="ai-session-context-menu-item">/);
  assert.match(contextMenu, /@select="\$emit\('openApp'\)"/);
  assert.match(contextMenu, /@select="\$emit\('closeSession'\)"/);
  assert.match(contextMenu, /@select="\$emit\('toggleTrigger', trigger\.configHash\)"/);
  assert.match(contextMenu, /:global\(\.ai-session-context-menu\)[\s\S]*backdrop-filter: blur\(16px\)/);
  assert.match(contextSubMenu, /<ContextMenuPortal>[\s\S]*<ContextMenuSubContent/);
});

test("an unselected AI session defaults to the new-session surface", () => {
  assert.match(panel, /const showNewSession = computed\(\(\) => newSessionOpen\.value \|\| !selectedSession\.value\);/);
  assert.match(panel, /<section v-else-if="showNewSession" class="session-ai-detail session-ai-new-detail">/);
  assert.match(panel, /<h1 class="session-ai-new-title">\{\{ t\("sessions\.panel\.startIdea"\) \}\}<\/h1>/);
  assert.match(styles, /\.session-ai-new-start\s*\{[^}]*width: min\(760px, 100%\);[^}]*gap: 48px;/s);
  assert.match(styles, /\.session-ai-new-title\s*\{[^}]*text-align: center;/s);
  assert.match(styles, /\.session-ai-new-dialog\s*\{[^}]*box-shadow: var\(--shadow-soft\);/s);
  assert.match(styles, /\.session-ai-new-dialog:focus-within\s*\{[^}]*var\(--shadow-soft\);/s);
  assert.match(panel, /watch\(\s*\[showNewSession, aiSessionLaunchableApps, newSessionFolders\]/);
  assert.doesNotMatch(panel, /session-ai-no-selection/);
});

test("opening the already-visible new-session surface preserves its draft", () => {
  assert.match(panel, /function openNewSession\(\) \{\s*const wasVisible = showNewSession\.value;\s*newSessionOpen\.value = true;[\s\S]{0,120}if \(wasVisible\) \{[\s\S]{0,80}return;[\s\S]{0,80}\}[\s\S]{0,120}newSessionDraft\.value = "";/);
});

test("new-session folder picker keeps actions visible while long folder lists scroll", () => {
  assert.match(panel, /<DropdownMenuContent class="session-ai-project-menu session-ai-project-picker-menu"[^>]*:collision-padding="12"/);
  assert.match(panel, /<ScrollArea type="auto" :horizontal="false" class="session-ai-project-list">[\s\S]*?filteredNewSessionFolders[\s\S]*?<\/ScrollArea>\s*<DropdownMenuSeparator \/>[\s\S]*?openNewProject/);
  assert.match(styles, /:global\(\.session-ai-project-picker-menu\)\s*\{[^}]*--reka-dropdown-menu-content-available-height[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;[^}]*overflow: hidden;/s);
  assert.match(styles, /\.session-ai-project-list\s*\{[^}]*min-height: 0;/s);
  assert.doesNotMatch(styles, /\.session-ai-project-list\s*\{[^}]*overflow-y: auto;/s);
  assert.match(scrollArea, /<ScrollBar v-if="horizontal" orientation="horizontal" \/>/);
});

test("new-session Git inspection reacts only to stable selection changes", () => {
  assert.match(panel, /watch\(\s*\[\(\) => props\.instance\.id, newSessionFolderId, showNewSession\]/);
  assert.doesNotMatch(panel, /\(\) => \[props\.instance\.id, newSessionFolderId\.value, showNewSession\.value\]/);
  assert.match(panel, /const abort = new AbortController\(\);\s*onCleanup\(\(\) => abort\.abort\(\)\);/);
  assert.match(panel, /getAiSessionWorkspace\(instanceId, folderId, abort\.signal\)/);
});

test("new-session branches use a folder tree and confirm current-folder switches", () => {
  assert.match(panel, /branch\.name\.split\("\/"\)\.filter\(Boolean\)/);
  assert.match(panel, /node\.kind === 'folder' \? toggleNewSessionBranchFolder\(\$event, node\.id\) : selectNewSessionBranch\(node\.branch\)/);
  assert.match(panel, /newSessionWorkspaceMode\.value === "worktree" \|\| branch\.current/);
  assert.match(panel, /newSessionBranchSwitchTarget\.value = branch;/);
  assert.match(panel, /<AlertDialog :open="Boolean\(newSessionBranchSwitchTarget\)"/);
  assert.match(panel, /confirmNewSessionBranchSwitch/);
  assert.match(panel, /newSessionWorkspaceMode\.value === "worktree" \? branch\.worktreeSelectable : branch\.currentFolderSelectable/);
});

test("new-session permission edits update the authoritative instance default", () => {
  assert.match(panel, /:permission-mode="newSessionPermissionMode"/);
  assert.match(panel, /@update:permission-mode="updateNewSessionPermissionMode"/);
  assert.match(panel, /updateControlledInstance\(props\.instance\.id, \{ config: \{ defaultCodexPermissionMode: permissionMode \} \}\)/);
  assert.match(panel, /newSessionPermissionMode\.value = previousPermissionMode/);
  assert.doesNotMatch(panel, /newAiSessionPermissionKey/);
});
