import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { groupAiSessionEntriesByPath } from "../src/apps/control-plane/instance-detail/aiSessionPathGrouping.ts";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const boardCard = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const contextMenu = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardContextMenu.vue", import.meta.url), "utf8");
const pathGroupContextMenu = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPathGroupContextMenu.vue", import.meta.url), "utf8");
const originMark = fs.readFileSync(new URL("../src/components/ai-session/AiSessionOriginMark.vue", import.meta.url), "utf8");
const cardMarks = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardMarks.vue", import.meta.url), "utf8");
const statusIndicator = fs.readFileSync(new URL("../src/components/ai-session/AiSessionStatusIndicator.vue", import.meta.url), "utf8");
const theme = fs.readFileSync(new URL("../../web-theme/theme.css", import.meta.url), "utf8");
const contextSubMenu = fs.readFileSync(new URL("../src/components/ui/context-menu/ContextMenuSubContent.vue", import.meta.url), "utf8");
const dropdownSubMenu = fs.readFileSync(new URL("../src/components/ui/dropdown-menu/DropdownMenuSubContent.vue", import.meta.url), "utf8");
const scrollArea = fs.readFileSync(new URL("../src/components/ui/scroll-area/ScrollArea.vue", import.meta.url), "utf8");

test("compact detail prompt keeps 16px before its divider", () => {
  assert.match(styles, /\.session-ai-detail-block \{[\s\S]*padding-bottom: 16px;/);
});

test("project rows show folder paths", () => {
  assert.match(panel, /class="session-ai-project-item session-ai-project-folder-item"[\s\S]*class="session-ai-project-folder-copy"[\s\S]*<strong>\{\{ folder\.name \}\}<\/strong>[\s\S]*<small>\{\{ folder\.path \}\}<\/small>/);
  assert.match(styles, /\.session-ai-project-folder-item\)[^{]*\{[^}]*min-height: 44px;/s);
  assert.match(styles, /\.session-ai-project-item\)[^{]*\{[^}]*font-weight: 500 !important;/s);
  assert.match(styles, /\.session-ai-project-folder-copy > strong\) \{ font-weight: 500; \}/);
  assert.match(styles, /\.session-ai-project-folder-copy > small\)[^{]*\{[^}]*color: var\(--text-muted\);[^}]*font-size: 12px;[^}]*font-weight: 400;/s);
});

test("AI session card and detail menus open Terminal at the authoritative session cwd", () => {
  assert.match(panel, /<AiSessionCardContextMenu[\s\S]*:can-open-terminal="Boolean\(terminalLaunchAppId\)"[\s\S]*@open-terminal="openSessionTerminal\(session\)"/);
  assert.match(panel, /<DropdownMenuItem[\s\S]*v-if="terminalLaunchAppId"[\s\S]*@select="openSessionTerminal\(selectedSession\)"[\s\S]*sessions\.actions\.openTerminal/);
  assert.match(panel, /function openSessionTerminal\(session: AiSessionSummary\) \{[\s\S]*emit\("launchApp", props\.instance, appId, undefined, \{ cwd: session\.cwd \}\);/);
  assert.match(contextMenu, /\.ai-session-context-menu \.ai-session-context-menu-item\) \{[\s\S]*font-size: 13px;/);
  assert.match(contextMenu, /\.ai-session-context-trigger-item strong\) \{[\s\S]*font-size: 13px;/);
  assert.match(styles, /\.session-ai-detail-actions-menu \.session-ai-detail-actions-menu-item\) \{[\s\S]*font-size: 13px;/);
});

test("AI session detail menu icons match the card context menu", () => {
  for (const icon of ["ExternalLink", "SquareTerminal", "Split"]) {
    assert.match(panel, new RegExp(`<${icon} :size="14" \\/>`));
    assert.match(contextMenu, new RegExp(`<${icon} :size="14" \\/>`));
  }
  assert.match(panel, /<Square :size="14" \/>/);
  assert.match(contextMenu, /<Square :size="14" \/>/);
});

test("AI session path groups share node-backed rename and desktop-local folder actions", () => {
  assert.match(panel, /<AiSessionPathGroupContextMenu[\s\S]*:can-open="canOpenPathGroupFolder"[\s\S]*:can-rename="canRenamePathGroup\(group\)"/);
  assert.match(panel, /function canRenamePathGroup[\s\S]*registeredPathGroupFolder\(group\)[\s\S]*nodeSupportsLocalFolderNameUpdate\(props\.instance\.node\)/);
  assert.match(panel, /updateNodeLocalFolder\(folder\.nodeId, folder\.id, \{ name \}\)/);
  assert.match(panel, /desktopRuntimePathAccess\(props\.instance\) === "desktop-local" && canOpenDesktopLocalPath\(\)/);
  assert.match(panel, /openDesktopLocalPath\(group\.path\)/);
  assert.match(pathGroupContextMenu, /ContextMenuItem v-if="canOpen" class="ai-session-path-group-menu-item"[\s\S]*sessions\.panel\.openInFileManager/);
  assert.match(pathGroupContextMenu, /ContextMenuItem v-if="canRename" class="ai-session-path-group-menu-item"[\s\S]*sessions\.panel\.renameProject/);
  assert.match(pathGroupContextMenu, /\.ai-session-context-menu \.ai-session-path-group-menu-item\) \{\s*gap: 8px;\s*font-size: 13px;/);
});

test("instance AI session cards always show the latest turn independently of detail navigation", () => {
  assert.doesNotMatch(panel, /<small>\{\{ aiSessionStatusLabel\(session\) \}\}<\/small>/);
  assert.match(panel, /function latestPromptIndex\(session: AiSessionSummary\) \{\s*return Math\.max\(0, promptCount\(session\) - 1\);\s*\}/);
  assert.match(panel, /displayAiSessionTitle\(session, latestPromptIndex\(session\), t\)/);
  assert.match(panel, /displayAiSessionMessage\(session, latestPromptIndex\(session\), t\)/);
  assert.doesNotMatch(panel, /class="session-ai-turn-nav"/);
  assert.match(panel, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(panel, /\(index \+ count\) % count/);
});

test("AI session list supports persistent card and compact-list layouts", () => {
  assert.match(panel, /type AiSessionListLayout = "cards" \| "list";/);
  assert.match(panel, /SESSION_LIST_LAYOUT_STORAGE_KEY = "task-handoff\.control-plane\.ai-sessions-list-layout"/);
  assert.match(panel, /return window\.localStorage\?\.getItem\(SESSION_LIST_LAYOUT_STORAGE_KEY\) === "list" \? "list" : "cards";/);
  assert.match(panel, /<DropdownMenuRadioGroup :model-value="sessionListLayout"/);
  assert.match(panel, /<DropdownMenuRadioItem[^>]*value="cards"/);
  assert.match(panel, /<DropdownMenuRadioItem[^>]*value="list"/);
  assert.match(panel, /v-if="sessionListLayout === 'list'"[\s\S]*class="session-ai-compact-row"/);
  assert.match(panel, /<span v-if="session\.unread" class="session-ai-compact-unread"[^>]*>/);
  assert.match(panel, /:class="\{ 'is-compact-list': sessionListLayout === 'list' \}"/);
  assert.match(panel, /:data-collapsed="groupSessionsByPath && collapsedPathGroups\[group\.key\] \? 'true' : undefined"/);
  assert.match(panel, /v-if="groupSessionsByPath"[^>]*:model-value="showEmptyPathGroups"/);
  assert.match(panel, /groupAiSessionEntriesByPath\(sessions, showEmptyPathGroups\.value \? newSessionFolders\.value : \[\]\)/);
  assert.match(panel, /watch\(showEmptyPathGroups, \(value\) => \{[\s\S]*localStorage\?\.setItem\(SHOW_EMPTY_PATH_GROUPS_STORAGE_KEY, String\(value\)\)/);
  assert.match(panel, /watch\(sessionListLayout, \(value\) => \{[\s\S]*localStorage\?\.setItem\(SESSION_LIST_LAYOUT_STORAGE_KEY, value\)/);
  assert.match(styles, /\.session-ai-compact-row\s*\{[\s\S]*grid-template-columns: 12px minmax\(0, 1fr\) auto;[\s\S]*gap: 6px;[\s\S]*min-height: 32px;/);
  assert.match(styles, /\.session-ai-compact-unread\s*\{[\s\S]*justify-self: end;[\s\S]*width: 7px;[\s\S]*height: 7px;[\s\S]*background: var\(--status-info\);/);
  assert.match(styles, /\.session-ai-path-group\.is-compact-list\s*\{\s*gap: 2px;/);
  assert.match(styles, /\.session-ai-path-group:not\(\[data-collapsed="true"\]\)\s*\{[\s\S]*padding-bottom: 6px;/);
  assert.doesNotMatch(styles, /\.session-ai-path-group\.is-compact-list[^}]*margin-bottom:/);
  assert.match(styles, /\.session-ai-path-group \+ \.session-ai-path-group\s*\{[\s\S]*margin-top: -6px;/);
  assert.doesNotMatch(styles, /\.session-ai-path-group \+ \.session-ai-path-group\[data-collapsed="true"\]/);
  assert.match(styles, /\.session-ai-path-group-title\s*\{[^}]*font-weight: 500;/s);
  assert.match(styles, /\.session-ai-compact-row\.is-grouped\s*\{\s*width: 100%;\s*margin-left: 0;\s*padding-left: 8px;/);
  assert.match(styles, /\.session-ai-compact-title\s*\{[^}]*font-weight: 400;/s);
  assert.match(statusIndicator, /\[data-size="compact"\]\[data-state="idle"\][^{]*\{\s*visibility: hidden;/);
  assert.match(styles, /\.session-ai-compact-row\[data-selected="true"\]\s*\{[\s\S]*background: var\(--ai-session-row-selected-bg\);/);
});

test("running AI sessions use one theme-aware loading ring across list and board cards", () => {
  assert.match(panel, /<AiSessionStatusIndicator :status="session\.status" size="compact" \/>/);
  assert.match(panel, /<AiSessionStatusIndicator :status="session\.status" \/>/);
  assert.match(panel, /<AiSessionStatusIndicator :status="sessionListPreviewSession\.status" \/>/);
  assert.match(boardCard, /<AiSessionStatusIndicator class="ai-board-status-indicator" :status="card\.session\.status" \/>/);
  assert.match(statusIndicator, /<span v-if="status === 'running'" class="ai-session-status-indicator__spinner" \/>/);
  assert.doesNotMatch(statusIndicator, /LoaderCircle|<svg|<circle/);
  assert.match(statusIndicator, /width: 12px;[\s\S]*height: 12px;[\s\S]*border: 1\.5px solid var\(--ai-session-running-track\);[\s\S]*\.ai-session-status-indicator__spinner::after[\s\S]*inset: -1\.5px;[\s\S]*border: 1\.5px solid currentColor;[\s\S]*border-top-color: transparent;[\s\S]*animation: ai-session-status-spin 1600ms linear infinite;/);
  assert.match(statusIndicator, /data-size="compact"[\s\S]*width: 12px;[\s\S]*height: 12px;/);
  assert.match(styles, /\.session-ai-state\s*\{[\s\S]*grid-template-columns: 12px minmax\(0, 1fr\);[\s\S]*gap: 8px;/);
  assert.match(boardCard, /\.ai-board-instance\s*\{[\s\S]*grid-template-columns: 12px minmax\(0, 1fr\);[\s\S]*gap: 9px;/);
  assert.match(statusIndicator, /vertical-align: middle;/);
  assert.match(statusIndicator, /prefers-reduced-motion: reduce/);
  assert.match(theme, /\[data-theme="light"\][\s\S]*--ai-session-running-indicator: rgb\(0 0 0 \/ 30%\);/);
  assert.match(theme, /\[data-theme="light"\][\s\S]*--ai-session-running-track: rgb\(0 0 0 \/ 10%\);/);
  assert.match(theme, /\[data-theme="dark"\][\s\S]*--ai-session-running-indicator: rgb\(255 255 255 \/ 30%\);/);
  assert.match(theme, /\[data-theme="dark"\][\s\S]*--ai-session-running-track: rgb\(255 255 255 \/ 10%\);/);
  assert.doesNotMatch(panel, /class="session-ai-(?:compact-)?dot"/);
  assert.doesNotMatch(boardCard, /class="ai-board-dot"/);
});

test("compact AI session rows reuse one delayed hover card that slides between rows", () => {
  assert.match(panel, /@mouseenter="showSessionListPreview\(\$event, session\)"/);
  assert.match(panel, /@pointermove="showSessionListPreview\(\$event, session\)"/);
  assert.match(panel, /supportsSessionListHoverPreview = useMediaQuery\("\(hover: hover\) and \(pointer: fine\)"\)/);
  assert.match(panel, /sessionListLayout\.value !== "list" \|\| !supportsSessionListHoverPreview\.value \|\| historyMode\.value/);
  assert.doesNotMatch(panel, /sessionListLayout\.value !== "list" \|\| compactAiSessionLayout\.value/);
  assert.match(panel, /<Teleport to="body">[\s\S]*v-if="sessionListPreviewVisible && sessionListPreviewSession"[\s\S]*class="session-ai-row session-ai-list-hover-card"/);
  assert.doesNotMatch(panel, /session-ai-list-hover-card"[\s\S]{0,240}:data-selected=/);
  assert.doesNotMatch(panel, /session-ai-list-hover-card[^>]*:key=/);
  assert.match(panel, /const SESSION_LIST_PREVIEW_DELAY_MS = 1_000;/);
  assert.match(panel, /const SESSION_LIST_PREVIEW_SKIP_DELAY_MS = 800;/);
  assert.match(panel, /const SESSION_LIST_PREVIEW_CLOSE_DELAY_MS = 120;/);
  assert.match(panel, /if \(sessionListPreviewVisible\.value \|\| Date\.now\(\) - sessionListPreviewClosedAt <= SESSION_LIST_PREVIEW_SKIP_DELAY_MS\)/);
  assert.match(styles, /:global\(\.session-ai-row\.session-ai-list-hover-card\)[\s\S]*position: fixed;[\s\S]*left 120ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\),[\s\S]*top 120ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/);
  assert.match(styles, /:global\(\.session-ai-list-preview-enter-from\),[\s\S]*opacity: 0;[\s\S]*transform: translateX\(-4px\);/);
});

test("AI session cards show the agent mark beside the optional terminal-origin mark", () => {
  assert.match(originMark, /v-if="creationSource === 'app-session'"/);
  assert.match(originMark, /<SquareTerminal :size="14"/);
  assert.match(originMark, /opacity: 0\.38;/);
  assert.match(cardMarks, /<AiAgentIcon :agent="brandedAgent" :size="14"/);
  assert.match(cardMarks, /props\.agent === "codex" \|\| props\.agent === "claude" \|\| props\.agent === "opencode" \? props\.agent : undefined/);
  assert.match(cardMarks, /<AiSessionOriginMark :creation-source="creationSource"/);
  assert.match(cardMarks, /\.ai-session-card-marks \{[\s\S]*?opacity: 0;[\s\S]*?transition: opacity 140ms ease;/);
  assert.match(panel, /<AiSessionCardMarks :agent="session\.agent" :creation-source="session\.creationSource"/);
  assert.match(boardCard, /<AiSessionCardMarks :agent="card\.session\.agent" :creation-source="card\.session\.creationSource"/);
  assert.match(styles, /\.session-ai-row:hover :deep\(\.ai-session-card-marks\),[\s\S]*?opacity: 1;/);
  assert.match(boardCard, /\.ai-board-card:hover :deep\(\.ai-session-card-marks\),[\s\S]*?opacity: 1;/);
  assert.match(styles, /\.ai-session-unread-dot \{[\s\S]*?right: 32px;/);
  assert.match(styles, /data-app-session-origin="true"\] \.ai-session-unread-dot \{\s*right: 50px;/);
  assert.match(boardCard, /\.ai-session-unread-dot \{[\s\S]*?right: 32px;/);
  assert.match(boardCard, /data-app-session-origin="true"\] \.ai-session-unread-dot \{\s*right: 50px;/);
  assert.doesNotMatch(originMark, /appSessionId/);
});

test("AI session path labels show only the folder and reveal the full path when hovered", () => {
  assert.match(panel, /v-if="!groupSessionsByPath" class="session-ai-card-workspace"/);
  assert.match(panel, /class="session-ai-card-workspace">\s*<span aria-hidden="true">·<\/span>/);
  assert.match(panel, /aiSessionBasename\(session\.cwd\)/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<b>/);
  assert.match(panel, /<TooltipContent[^>]*>\{\{ session\.cwd \|\| t\("sessions\.board\.unknownPath"\) \}\}<\/TooltipContent>/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<span class="session-ai-path-group-title">/);
  assert.match(styles, /\.session-ai-card-workspace\s*\{[^}]*flex: 1 1 0;[^}]*color: color-mix\(in srgb, var\(--text-muted\) 78%, transparent\);[^}]*font-size: 13px;/s);
  assert.match(styles, /\.session-ai-card-workspace b\s*\{[^}]*flex: 1 1 auto;[^}]*color: inherit;[^}]*font-size: inherit;[^}]*font-weight: inherit;/s);
  assert.match(styles, /\.session-ai-state-line\s*\{[^}]*gap: 4px;/s);
  assert.match(styles, /\.session-ai-state-line > strong\s*\{[^}]*color: color-mix\(in srgb, var\(--text-muted\) 78%, transparent\);/s);
  assert.match(styles, /\.session-ai-card-workspace\s*\{[^}]*gap: 4px;/s);
  assert.doesNotMatch(styles, /\.session-ai-state\s*\{[^}]*padding-right:/s);
});

test("AI session path groups create a session in their registered project", () => {
  assert.doesNotMatch(panel, /group\.(?:sessions|items)\.length/);
  assert.match(panel, /groupAiSessionEntriesByPath\(sessions, showEmptyPathGroups\.value \? newSessionFolders\.value : \[\]\)/);
  assert.match(panel, /groupAiSessionEntriesByPath\(items\)/);
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

test("AI session path groups merge the same cwd regardless of folder ID provenance", () => {
  const groups = groupAiSessionEntriesByPath([
    { cwd: "/Users/huadream/project/codex", id: "legacy" },
    { cwd: "/Users/huadream/project/codex/", cwdFolderId: "folder-codex", id: "registered" },
  ]);

  assert.deepEqual(groups, [{
    key: "cwd:/Users/huadream/project/codex",
    path: "/Users/huadream/project/codex",
    cwdFolderId: "folder-codex",
    entries: [
      { cwd: "/Users/huadream/project/codex", id: "legacy" },
      { cwd: "/Users/huadream/project/codex/", cwdFolderId: "folder-codex", id: "registered" },
    ],
  }]);
});

test("AI session path groups optionally include registered folders without sessions", () => {
  const groups = groupAiSessionEntriesByPath(
    [{ cwd: "/workspace/active/", id: "session" }],
    [
      { id: "folder-active", path: "/workspace/active" },
      { id: "folder-empty", path: "/workspace/empty/" },
    ],
  );

  assert.deepEqual(groups, [
    {
      key: "cwd:/workspace/active",
      path: "/workspace/active",
      cwdFolderId: "folder-active",
      entries: [{ cwd: "/workspace/active/", id: "session" }],
    },
    {
      key: "cwd:/workspace/empty",
      path: "/workspace/empty",
      cwdFolderId: "folder-empty",
      entries: [],
    },
  ]);
});

test("instance AI session card user messages use a single unpadded line", () => {
  assert.match(styles, /\.session-ai-preview-field-user\s*\{[^}]*max-height: 18px;[^}]*padding-block: 0;/s);
  assert.match(styles, /\.session-ai-question\s*\{[^}]*-webkit-line-clamp: 1;/s);
  assert.doesNotMatch(styles, /\.session-ai-question\s*\{[^}]*font-weight:\s*800;/s);
  assert.match(styles, /\.session-ai-question :deep\(p\),\s*\.session-ai-message :deep\(p\)\s*\{\s*margin: 0;/s);
});

test("instance AI session cards omit metadata and turn-navigation footers", () => {
  assert.doesNotMatch(panel, /aiSessionContext/);
  assert.doesNotMatch(panel, /session-ai-card-meta/);
  assert.doesNotMatch(panel, /session-ai-turn-nav/);
  assert.doesNotMatch(styles, /\.session-ai-turn-nav/);
  assert.match(styles, /grid-template-rows: auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.session-ai-select\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(styles, /\.session-ai-preview-field-assistant\s*\{[^}]*padding: 10px 14px 0;/s);
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

test("mobile AI sessions keep detail visible and float the session list in a dismissible sheet", () => {
  assert.match(panel, /<Sheet v-model:open="sessionListOverlayOpen">/);
  assert.match(panel, /ref="panelEl" class="session-ai-panel"/);
  assert.match(panel, /const panelBounds = useElementBounding\(panelEl\);/);
  assert.match(panel, /overlayStyle: sessionListOverlayBackdropStyle/);
  assert.match(panel, /style: sessionListOverlayStyle/);
  assert.match(panel, /:is="compactAiSessionLayout \? SheetContent : 'div'"/);
  assert.match(panel, /'session-ai-sidebar-sheet': compactAiSessionLayout/);
  assert.match(panel, /class="session-ai-mobile-list-button"[\s\S]*:data-open="sessionListOverlayOpen \? 'true' : undefined"[\s\S]*@click="sessionListOverlayOpen = true"[\s\S]*<PanelLeftOpen/);
  assert.match(panel, /watch\(compactAiSessionLayout, \(compact\) => \{\s*if \(!compact\) sessionListOverlayOpen\.value = false;\s*\}\);/);
  assert.match(panel, /watch\(\(\) => props\.instance\.id, \(\) => \{\s*sessionListOverlayOpen\.value = false;/);
  assert.doesNotMatch(panel, /if \(compact && !wasCompact\)[\s\S]*sessionListOverlayOpen\.value = true/);
  assert.match(panel, /<TooltipContent side="right" :side-offset="6">\{\{ t\("sessions\.panel\.sessionList"\) \}\}<\/TooltipContent>/);
  assert.match(panel, /function selectSession\(sessionId: string\) \{[\s\S]*sessionListOverlayOpen\.value = false;[\s\S]*emit\("selectAiSession"/);
  assert.doesNotMatch(panel, /mobilePane|data-mobile-pane|showMobileSessionList/);
  assert.match(styles, /:global\(\.session-ai-sidebar-overlay\) \{\s*background: rgb\(0 0 0 \/ 10%\);/);
  assert.match(panel, /top: `\$\{panelBounds\.top\.value\}px`[\s\S]*bottom: `calc\(100vh - \$\{panelBounds\.bottom\.value\}px\)`[\s\S]*left: `\$\{panelBounds\.left\.value\}px`[\s\S]*width: `\$\{Math\.min\(sidebarWidth\.value, Math\.max\(0, panelBounds\.width\.value - 40\)\)\}px`[\s\S]*padding: "0"/);
  assert.match(panel, /class="session-ai-drawer-resize-handle"[\s\S]*@pointerdown="startSidebarResize"/);
  assert.match(panel, /const maximumWidth = compactAiSessionLayout\.value[\s\S]*panelBounds\.width\.value - 40[\s\S]*sidebarWidth\.value = Math\.min\(maximumWidth, Math\.max\(minimumWidth/);
  assert.match(styles, /:global\(\.session-ai-drawer-resize-handle\) \{[\s\S]*right: 0;[\s\S]*width: 10px;[\s\S]*cursor: col-resize;/);
  assert.match(styles, /:global\(\.session-ai-sidebar-sheet\) \{[\s\S]*border-right: 1px solid var\(--line-strong\);[\s\S]*border-radius: 0;[\s\S]*transition-duration: 200ms;/);
  assert.match(styles, /:global\(\.session-ai-sidebar-sheet \.session-ai-sidebar\) \{[\s\S]*--session-ai-list-left-inset: 12px;[\s\S]*--session-ai-list-right-inset: 12px;[\s\S]*--session-ai-list-bottom-inset: 12px;[\s\S]*padding: 12px 0 12px 12px;/);
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-panel \{\s*--session-ai-scrollbar-outset: 0px;\s*padding: 8px;[\s\S]*grid-template-rows: minmax\(0, 1fr\);[\s\S]*\.session-ai-mobile-list-button \{[\s\S]*position: absolute;[\s\S]*top: 10px;[\s\S]*left: 4px;[\s\S]*width: 26px;[\s\S]*height: 26px;/);
  assert.match(styles, /\.session-ai-detail-content > header \{\s*padding-left: 24px;/);
  assert.match(styles, /\.session-ai-detail-content > header > \.session-ai-detail-prompt-stage \{[\s\S]*width: calc\(100% \+ 24px\);[\s\S]*margin-left: -24px;[\s\S]*padding-left: 24px;/);
  assert.doesNotMatch(styles, /\.session-ai-detail\.is-scrolled \.session-ai-detail-content > header/);
  assert.match(styles, /\.session-ai-mobile-list-button \{[\s\S]*border-color: transparent;[\s\S]*background: transparent;/);
  assert.match(styles, /\.session-ai-mobile-list-button\[data-open="true"\] \{[\s\S]*border-color: transparent;[\s\S]*background: var\(--surface-hover\);/);
  assert.doesNotMatch(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-preview-field-assistant \{\s*padding-right: 38px;/);
  assert.doesNotMatch(styles, /@media \(max-width: 920px\)[\s\S]*\.session-ai-select \{\s*padding-right: 38px;/);
  assert.doesNotMatch(styles, /grid-template-rows: minmax\(220px, 42vh\) minmax\(0, 1fr\)/);
});

test("the return-to-latest control stays compact and visually separated from the composer", () => {
  assert.match(panel, /class="session-ai-follow-latest"[\s\S]*size="icon-sm"[\s\S]*variant="ghost"[\s\S]*<ChevronDown :size="17" \/>/);
  assert.doesNotMatch(panel, /<ArrowDown/);
  assert.match(styles, /\.session-ai-follow-latest\s*\{[^}]*bottom: calc\([^}]*var\(--session-ai-compose-offset, 84px\)[^}]*var\(--session-ai-compose-bottom\)[^}]*var\(--session-ai-content-bottom-gap\)[^}]*\);[^}]*width: 32px;[^}]*height: 32px;[^}]*background: color-mix\(in srgb, var\(--surface-raised\) 62%, transparent\);[^}]*backdrop-filter: blur\(10px\);/s);
});

test("all instance AI sessions expose close through the unified context menu", () => {
  assert.match(panel, /<AiSessionCardContextMenu[\s\S]*?@close-session="closeSession\(session\)"/);
  assert.match(panel, /await closeAiSession\(props\.instance\.id, session\.id, createBrowserUuid\(\)\);/);
  assert.match(panel, /aiSessionAppTab\(instance, session\) \|\| session\.actions\?\.openApp/);
});

test("instance and board cards omit duplicate hover action buttons", () => {
  for (const source of [panel, boardCard]) {
    assert.doesNotMatch(source, /ai-session-card-action/);
    assert.doesNotMatch(source, /card-tools/);
  }
  assert.doesNotMatch(styles, /session-ai-card-tools|session-ai-trigger-button/);
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
  assert.match(dropdownSubMenu, /<DropdownMenuPortal>[\s\S]*<DropdownMenuSubContent/);
});

test("an unselected AI session defaults to the new-session surface", () => {
  assert.match(panel, /const showNewSession = computed\(\(\) => newSessionOpen\.value \|\| !selectedSession\.value\);/);
  assert.match(panel, /const selectedListSessionId = computed\(\(\) => showNewSession\.value \? undefined : selectedSession\.value\?\.id\);/);
  assert.match(panel, /:data-selected="selectedListSessionId === session\.id"/);
  assert.doesNotMatch(panel, /:data-selected="selectedSession\?\.id === session\.id"/);
  assert.match(panel, /<section v-else-if="showNewSession" class="session-ai-detail session-ai-new-detail">/);
  assert.match(panel, /<h1 class="session-ai-new-title">\{\{ t\("sessions\.panel\.startIdea"\) \}\}<\/h1>/);
  assert.match(styles, /\.session-ai-new-start\s*\{[^}]*width: min\(760px, 100%\);[^}]*gap: 48px;/s);
  assert.match(styles, /\.session-ai-new-title\s*\{[^}]*text-align: center;/s);
  assert.match(styles, /\.session-ai-new-dialog\s*\{[^}]*box-shadow: var\(--shadow-soft\);/s);
  assert.match(styles, /\.session-ai-new-dialog:focus-within\s*\{[^}]*var\(--shadow-soft\);/s);
  assert.match(panel, /watch\(\s*\[showNewSession, aiSessionLaunchableApps, newSessionFolders\]/);
  assert.doesNotMatch(panel, /session-ai-no-selection/);
});

test("new-session drafts persist per instance until creation succeeds", () => {
  assert.match(panel, /activeNewSessionDraftKey = ref\(aiSessionCreationDraftKey\(props\.instance\.id\)\)/);
  assert.match(panel, /watch\(\[newSessionDraft, newSessionMentionBindings\],[\s\S]*persistAiSessionDraftPayload\(activeNewSessionDraftKey\.value, draft, bindings\)/);
  assert.match(panel, /watch\(\(\) => props\.instance\.id,[\s\S]*loadAiSessionDraftPayload\(activeNewSessionDraftKey\.value\)/);
  assert.match(panel, /v-model="newSessionDraft"[\s\S]*v-model:mention-bindings="newSessionMentionBindings"/);
  assert.doesNotMatch(panel, /function openNewSession\(\)[\s\S]{0,400}newSessionDraft\.value = "";/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, result\.aiSessionId\);\s*clearAiSessionDraft\(activeNewSessionDraftKey\.value\);\s*newSessionDraft\.value = "";/);
});

test("new-session folder picker keeps actions visible while long folder lists scroll", () => {
  assert.match(panel, /<DropdownMenuContent class="session-ai-project-menu session-ai-project-picker-menu"[^>]*:collision-padding="12"/);
  assert.match(panel, /<ScrollArea type="auto" :horizontal="false" class="session-ai-project-list">[\s\S]*?filteredNewSessionFolders[\s\S]*?<\/ScrollArea>\s*<template v-if="instance\.source\.type === 'local-folder'">[\s\S]*?<DropdownMenuSeparator \/>[\s\S]*?openNewProject/);
  assert.match(styles, /:global\(\.session-ai-project-picker-menu\)\s*\{[^}]*--reka-dropdown-menu-content-available-height[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;[^}]*overflow: hidden;/s);
  assert.match(styles, /\.session-ai-project-list\s*\{[^}]*min-height: 0;/s);
  assert.doesNotMatch(styles, /\.session-ai-project-list\s*\{[^}]*overflow-y: auto;/s);
  assert.match(scrollArea, /<ScrollBar v-if="horizontal" orientation="horizontal" \/>/);
});

test("new-session Git inspection reacts only to stable selection changes", () => {
  assert.match(panel, /watch\(\s*\[\(\) => props\.instance\.id, newSessionFolderId, showNewSession\]/);
  assert.doesNotMatch(panel, /\(\) => \[props\.instance\.id, newSessionFolderId\.value, showNewSession\.value\]/);
  assert.match(panel, /const abort = new AbortController\(\);\s*onCleanup\(\(\) => abort\.abort\(\)\);/);
  assert.match(panel, /getAiSessionWorkspace\(instanceId, cwdFolderId, abort\.signal\)/);
});

test("new-session Git inspection uses cached workspace data without blocking the composer", () => {
  assert.match(panel, /controlPlaneQueryKeys\.aiSessionWorkspace\(instanceId, cwdFolderId\)/);
  assert.match(panel, /getQueryData<RepositoryAiSessionWorkspace>\(queryKey\)[\s\S]*newSessionWorkspace\.value = cachedWorkspace[\s\S]*getAiSessionWorkspace\(instanceId, cwdFolderId, abort\.signal\)/);
  assert.match(panel, /queryClient\.setQueryData\(queryKey, workspace\)/);
  assert.match(panel, /const newSessionComposerBusy = computed\(\(\) => launchingNewSession\.value \|\| savingNewSessionPermission\.value \|\| choosingNewSessionFolder\.value\);/);
  assert.doesNotMatch(panel, /const newSessionComposerBusy = computed\([^\n]*newSessionWorkspaceLoading/);
  assert.match(panel, /:disabled="!newSessionFolder \|\| \(newSessionWorkspaceLoading && !newSessionWorkspace\)"/);
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
