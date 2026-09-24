import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const sidebar = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryResourceSidebar.vue", import.meta.url), "utf8");
const tabStrip = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryResourceTabStrip.vue", import.meta.url), "utf8");
const sharedTabStrip = fs.readFileSync(new URL("../src/apps/control-plane/shared/ResourceTabStrip.vue", import.meta.url), "utf8");
const sharedTabItem = fs.readFileSync(new URL("../src/apps/control-plane/shared/ResourceTabItem.vue", import.meta.url), "utf8");
const sharedTabViewport = fs.readFileSync(new URL("../src/apps/control-plane/shared/ResourceTabViewport.vue", import.meta.url), "utf8");
const appLaunchMenuItems = fs.readFileSync(new URL("../src/apps/control-plane/shared/AppLaunchMenuItems.vue", import.meta.url), "utf8");
const sessionPreview = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.vue", import.meta.url), "utf8");
const sessionPreviewStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.css", import.meta.url), "utf8");
const pane = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPaneContent.vue", import.meta.url), "utf8");
const instanceList = fs.readFileSync(new URL("../src/apps/control-plane/instance-list/InstanceList.vue", import.meta.url), "utf8");
const layoutMenu = fs.readFileSync(new URL("../src/apps/control-plane/shared/WorkbenchLayoutContextMenu.vue", import.meta.url), "utf8");
const actionMenuStyles = fs.readFileSync(new URL("../src/apps/control-plane/shared/InstanceActionMenu.css", import.meta.url), "utf8");
const tabRename = fs.readFileSync(new URL("../src/apps/control-plane/shared/resourceTabRename.ts", import.meta.url), "utf8");

test("inline rename editor keeps the shared tab label metric in every strip", () => {
  assert.match(sharedTabItem, /\.session-tab-text strong \{[\s\S]*font-size: 13px;[\s\S]*font-weight: 400;/);
  assert.match(sharedTabItem, /\.session-tab-title-input \{[\s\S]*font-family: inherit;[\s\S]*font-size: 13px;[\s\S]*font-weight: 400;[\s\S]*line-height: 18px;/);
  assert.doesNotMatch(sharedTabItem, /\.session-tab-title-input \{[^}]*font: inherit;/);
  assert.doesNotMatch(sessionPreviewStyles, /\.session-tab-title-input/);
  assert.doesNotMatch(tabStrip, /\.session-tab-title-input/);
});

test("resource toggle follows account controls and is separated as its own tool", () => {
  const accountControl = Math.max(workbench.indexOf("control-plane-settings-trigger"), workbench.indexOf("control-plane-user-trigger"));
  const divider = workbench.indexOf("story-resource-toggle-divider", accountControl);
  const toggle = workbench.indexOf("story-resource-toggle", divider + 1);
  assert.ok(accountControl >= 0 && divider > accountControl && toggle > divider);
  assert.doesNotMatch(workbench, /<template(?:\s[^>]*)?>\s*<span class="story-resource-toggle-divider"/);
  assert.match(workbenchStyles, /\.story-resource-toggle-divider\s*\{[\s\S]*width:\s*1px;[\s\S]*height:\s*18px;/);
  assert.match(workbench, /<TooltipTrigger as-child>[\s\S]*class="story-resource-toggle-trigger"[\s\S]*class="story-resource-toggle"/);
  assert.match(workbenchStyles, /\.story-resource-toggle-trigger\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*width:\s*30px;[\s\S]*height:\s*30px;/);
  assert.match(workbenchStyles, /\.story-resource-toggle\s*\{[\s\S]*width:\s*30px;[\s\S]*border-radius:\s*6px;/);
  assert.doesNotMatch(workbench, /<template v-if="storyMode && !settingsMode">[\s\S]*story-resource-toggle/);
  assert.match(workbench, /class="story-resource-toggle"[\s\S]*:disabled="!storyResourceTargetAiSessionId"/);
});

test("inline sidebar renders one divider while overlay retains its panel edge", () => {
  assert.match(workbenchStyles, /\.story-resource-layout:not\(\.overlay-mode\) \.story-resource-panel\s*\{[\s\S]*border-left:\s*1px solid var\(--line\)/);
  assert.match(workbenchStyles, /\.story-resource-layout\.sidebar-visible:not\(\.overlay-mode\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(520px, 1fr\) var\(--story-resource-width\)/);
  assert.match(workbenchStyles, /\.story-resource-resize-handle\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*0;[\s\S]*transform:\s*translateX\(50%\)/);
  assert.match(workbenchStyles, /\.story-resource-layout\.sidebar-visible:not\(\.overlay-mode\) \.story-resource-resize-handle\s*\{[\s\S]*right:\s*var\(--story-resource-width\);/);
  assert.match(workbenchStyles, /\.story-resource-resize-handle::before\s*\{[\s\S]*width:\s*1px;[\s\S]*background:\s*transparent/);
  assert.match(workbenchStyles, /\.story-resource-resize-handle:hover,[\s\S]*\.story-resource-resize-handle:focus-visible\s*\{[\s\S]*background:\s*transparent/);
  assert.doesNotMatch(workbenchStyles, /\.story-resource-resize-handle:hover[^}]*border-color/);
  assert.match(workbenchStyles, /\.story-resource-layout\.overlay-mode \.story-resource-panel\s*\{[\s\S]*border-left:\s*1px solid var\(--line\)/);
});

test("sidebar exposes keyboard resize and overlay focus semantics", () => {
  assert.match(workbench, /role="separator"[\s\S]*aria-orientation="vertical"[\s\S]*:aria-valuemin="STORY_RESOURCE_SIDEBAR_MIN_WIDTH"[\s\S]*:aria-valuenow="storyResourceSidebar\.width\.value"/);
  assert.match(workbench, /@keydown\.esc="closeStoryResourceOverlay"/);
  assert.match(workbench, /document\.querySelector\("\.story-resource-panel"\)[\s\S]*\.focus\(\)/);
  assert.match(workbench, /document\.querySelector\("\.story-resource-toggle"\)[\s\S]*\.focus\(\)/);
  assert.match(sidebar, /<aside class="story-resource-sidebar" tabindex="-1"/);
  assert.match(tabStrip, /<ResourceTabItem[\s\S]*:tabindex="item\.key === activeKey \? 0 : -1"/);
  assert.match(sharedTabItem, /role="tab"[\s\S]*:aria-selected="active"/);
  assert.match(sharedTabStrip, /event\.key === "ArrowLeft"[\s\S]*event\.key === "ArrowRight"[\s\S]*event\.key === "Home"[\s\S]*event\.key === "End"/);
});

test("Story and instance detail adapt their existing tabs through the shared strip", () => {
  assert.match(tabStrip, /<ResourceTabStrip[\s\S]*<ResourceTabViewport[\s\S]*@pointerdown="startPointer/);
  assert.match(tabStrip, /function movePointer[\s\S]*Math\.hypot[\s\S]*scrollAtPointer/);
  assert.match(tabStrip, /<ContextMenu>[\s\S]*<ContextMenuTrigger as-child>[\s\S]*<ResourceTabItem/);
  assert.match(tabStrip, /<ContextMenuContent[\s\S]*@select="\$emit\('close', item\.key\)"/);
  assert.match(tabStrip, /@mouseenter="showTabDetail\(\$event, item\)"[\s\S]*@mouseleave="scheduleTabDetailClose"/);
  assert.match(tabStrip, /function showTabDetail[\s\S]*setTimeout/);
  assert.match(sharedTabViewport, /function scrollAtPointer/);
  assert.match(sessionPreview, /<ResourceTabStrip[\s\S]*:items="previewSessionTabs\(tabGroup\.id, tabGroup\.appTabs\)"[\s\S]*@select="\$emit\('selectSession', \$event, tabGroup\.id\)"/);
  assert.match(sessionPreview, /data-session-tab-key[\s\S]*data-resource-tab-key/);
});

test("Story tab hover detail reuses the shared instance detail card", () => {
  assert.match(tabStrip, /<Transition name="session-tab-detail">[\s\S]*class="session-tab-detail-tooltip"/);
  assert.match(tabStrip, /class="session-tab-detail-title">\{\{ tabDetailItem\.label \}\}<\/strong>[\s\S]*class="session-tab-detail-subtitle">\{\{ tabDetailItem\.description \}\}/);
  assert.match(tabStrip, /if \(tabDetailVisible\.value \|\| Date\.now\(\) - tabDetailClosedAt <= TAB_DETAIL_SKIP_DELAY_MS\)/);
  assert.match(tabStrip, /tabDetailOpenTimer = setTimeout\(\(\) => \{ tabDetailVisible\.value = true; tabDetailOpenTimer = undefined; \}, TAB_DETAIL_DELAY_MS\)/);
  assert.match(sharedTabItem, /\.session-tab-detail-tooltip \{[\s\S]*transition:\s*left 120ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\),\s*top 120ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/);
  assert.doesNotMatch(tabStrip, /story-resource-tab-detail/);
  assert.doesNotMatch(tabStrip, /:title="item\.description"/);
});

test("inline tab rename keeps the editor focused after its context menu closes", () => {
  assert.match(tabRename, /export async function focusResourceTabTitleInput\(input: Ref<HTMLInputElement \| undefined>\) \{\s*await nextTick\(\);\s*const deadline = performance\.now\(\) \+ FOCUS_RETRY_WINDOW_MS;/);
  assert.match(tabStrip, /await focusResourceTabTitleInput\(renameInput\)/);
  assert.match(tabStrip, /@close-auto-focus="holdRenameFocus"/);
  assert.match(sessionPreview, /await focusResourceTabTitleInput\(renameInput\)/);
  assert.match(sessionPreview, /@close-auto-focus="holdSessionRenameFocus"/);
});

test("Story tab context menu keeps rename and close on the shared instance action menu chrome", () => {
  assert.match(tabStrip, /<ContextMenuContent class="instance-action-menu story-resource-tab-menu" @close-auto-focus="holdRenameFocus">/);
  assert.match(tabStrip, /<Pencil :size="14" \/>\s*<span>\{\{ t\("sessions\.tabs\.rename"\) \}\}<\/span>\s*<\/ContextMenuItem>\s*<ContextMenuSeparator v-if="item\.rename" \/>\s*<ContextMenuItem class="instance-action-item" :disabled="item\.closing" @select="\$emit\('close', item\.key\)">\s*<X :size="14" \/>/);
  assert.match(tabStrip, /:disabled="item\.rename === 'unavailable' \|\| item\.closing"[\s\S]*@select="beginRename\(item\)"/);
  assert.match(tabStrip, /async function beginRename\(item: StoryResourceTabItem\) \{\s*if \(item\.rename !== "enabled" \|\| !props\.renameResource \|\| item\.closing\) return;[\s\S]*await focusResourceTabTitleInput\(renameInput\);/);
  assert.match(tabStrip, /function holdRenameFocus\(event: Event\) \{\s*if \(editingKey\.value\) event\.preventDefault\(\);/);
  assert.match(tabStrip, /await props\.renameResource\?\.\(item\.key, title\)/);
  assert.match(tabStrip, /showControlPlaneToast\(translateApiError\(error, t, t\("sessions\.tabs\.renameFailed"\)\)\)/);
  assert.match(sidebar, /:rename-resource="renameAppSessionResource"/);
  assert.match(sidebar, /function storyResourceRenameState[\s\S]*canRenameAppSession\(instance, resource\.sessionId\) \? "enabled" : "unavailable"/);
  assert.match(sidebar, /async function renameAppSessionResource\(key: string, title: string\) \{\s*const resource = props\.resources\.find\(\(candidate\) => storyResourceKey\(candidate\) === key\);\s*if \(resource\?\.kind !== "app-session" \|\| !props\.renameResource\) return;\s*await props\.renameResource\(resource\.instanceId, resource\.sessionId, title\);/);
  assert.match(workbench, /:node-local-folders-by-node-id="nodeLocalFoldersByNodeId"[\s\S]*:rename-resource="renameStoryResource"/);
  assert.match(workbench, /async function renameStoryResource\(instanceId: string, sessionId: string, title: string\) \{\s*await renameAppSession\(instanceId, sessionId, title\);\s*\}/);
});

test("instance action menus share one chrome definition", () => {
  assert.match(actionMenuStyles, /\.instance-action-menu \{[\s\S]*display: grid;[\s\S]*background: var\(--surface-inset\);[\s\S]*box-shadow: var\(--shadow-popover\);[\s\S]*padding: 5px;/);
  assert.match(actionMenuStyles, /\.instance-action-menu \.instance-action-item \{[\s\S]*min-height: 30px;[\s\S]*font-size: 13px;[\s\S]*font-weight: 500;/);
  assert.match(actionMenuStyles, /\.instance-action-menu \.instance-action-item\[data-highlighted\][\s\S]*background: var\(--surface-active\);/);
  assert.match(actionMenuStyles, /\.instance-action-menu \.instance-action-item\[data-disabled\] \{\s*cursor: default;\s*opacity: 0\.52;/);
  assert.match(tabStrip, /<style src="\.\.\/shared\/InstanceActionMenu\.css"><\/style>/);
  assert.match(instanceList, /<style src="\.\.\/shared\/InstanceActionMenu\.css"><\/style>/);
  assert.match(layoutMenu, /<style src="\.\/InstanceActionMenu\.css"><\/style>/);
  assert.doesNotMatch(instanceList, /\.instance-action-item[\s:]/);
  assert.match(layoutMenu, /\.instance-action-menu\.workbench-layout-context-menu \{\s*width: 172px;\s*\}/);
  assert.match(tabStrip, /:global\(\.instance-action-menu\.story-resource-tab-menu\) \{\s*width: 172px;\s*\}/);
  assert.doesNotMatch(sessionPreviewStyles, /\.instance-action-item:hover/);
});

test("Story resource panel uses the instance detail surface palette", () => {
  assert.match(sidebar, /\.story-resource-sidebar[^{]*\{[^}]*background:var\(--terminal-bg\);[^}]*color:var\(--terminal-text\)/);
  assert.match(sidebar, /\.story-resource-header[^{]*\{[^}]*border-bottom:1px solid var\(--line\);[^}]*background:var\(--surface-raised\);[^}]*color:var\(--text-muted\)/);
  assert.match(sidebar, /\.story-resource-empty[^{]*\{[^}]*background:var\(--terminal-bg\)/);
  assert.doesNotMatch(sidebar, /\.story-resource-empty[^{]*\{[^}]*workspace-grid/);
  assert.match(sidebar, /\.story-resource-header-action:hover[\s\S]*background:color-mix\(in srgb,var\(--surface-raised\) 92%,var\(--white\) 4%\)/);
  assert.match(sidebar, /\.story-resource-header-action[^{]*\{[^}]*width:28px;[^}]*height:28px;[^}]*border-radius:7px;[^}]*background:transparent/);
  assert.doesNotMatch(sidebar, /PanelRightClose|stories\.resources\.collapse|emit\('collapse'\)|collapse: \[\]/);
});

test("sidebar expand and collapse animate without dropping the exit layout track", () => {
  assert.match(workbench, /<Transition name="story-resource-panel" :css="!storyResourceContextChanging">[\s\S]*<StoryResourceSidebar/);
  assert.match(workbench, /<Transition name="story-resource-scrim" :css="!storyResourceContextChanging">[\s\S]*story-resource-scrim/);
  assert.match(workbench, /class="story-resource-resize-handle"[\s\S]*:class="\{ hidden: !storyResourceSidebar\.visible\.value \|\| storyResourceOverlay \}"/);
  assert.match(workbench, /const STORY_RESOURCE_LAYOUT_ANIMATION_MS = 200;/);
  assert.match(workbench, /const storyResourceLayoutAnimating = ref\(false\)/);
  assert.match(workbench, /'layout-animating': storyResourceLayoutAnimating/);
  assert.match(workbench, /function playStoryResourceLayoutAnimation\(\)[\s\S]*storyResourceLayoutAnimating\.value = true;[\s\S]*window\.setTimeout\([\s\S]*storyResourceLayoutAnimating\.value = false;/);
  assert.match(workbench, /watch\(\[\(\) => storyResourceSidebar\.visible\.value, storyResourceContextKey\], \(\[visible, contextKey\], \[previousVisible, previousContextKey\]\) => \{/);
  assert.match(workbenchStyles, /\.story-resource-layout\.layout-animating \{\s*transition: grid-template-columns 180ms cubic-bezier\(0\.2, 0, 0, 1\);/);
  assert.match(workbenchStyles, /\.story-resource-layout\.layout-animating \.story-resource-resize-handle \{\s*transition: right 180ms cubic-bezier\(0\.2, 0, 0, 1\);/);
  assert.match(workbenchStyles, /\.story-resource-panel-enter-active[\s\S]*transform 180ms/);
  assert.match(workbenchStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.story-resource-layout\.layout-animating,/);
});

test("context switches keep the sidebar layout instant while same-context toggles animate", () => {
  assert.match(workbench, /const storyResourceContextKey = computed\(\(\) => `\$\{storyResourceTargetInstanceId\.value\}:\$\{storyResourceTargetAiSessionId\.value\}`\)/);
  assert.match(workbench, /watch\(storyResourceContextKey[\s\S]*storyResourceContextChanging\.value = true[\s\S]*flush: "sync"/);
  assert.match(workbench, /<Transition name="story-resource-panel" :css="!storyResourceContextChanging">/);
  const contextKeyWatcher = workbench.slice(workbench.indexOf("watch(storyResourceContextKey"), workbench.indexOf("watch([() => storyResourceSidebar.visible.value, storyResourceContextKey]"));
  assert.ok(contextKeyWatcher.length > 0);
  assert.doesNotMatch(contextKeyWatcher, /playStoryResourceLayoutAnimation/);
  const layoutAnimationWatcher = workbench.slice(workbench.indexOf("watch([() => storyResourceSidebar.visible.value, storyResourceContextKey]"), workbench.indexOf("function startStoryResourceResize"));
  assert.ok(layoutAnimationWatcher.length > 0);
  assert.match(layoutAnimationWatcher, /if \(visible === previousVisible \|\| contextKey !== previousContextKey \|\| storyResourceContextChanging\.value\) return;/);
  assert.match(layoutAnimationWatcher, /playStoryResourceLayoutAnimation\(\);/);
  assert.doesNotMatch(layoutAnimationWatcher, /flush: "sync"/);
  assert.match(workbenchStyles, /\.story-resource-layout\.context-changing \{\s*transition: none;/);
});

test("pointer resizing bypasses the expand and collapse transition", () => {
  assert.match(workbench, /resizing:\s*storyResourceResizing/);
  assert.match(workbench, /function startStoryResourceResize[\s\S]*storyResourceResizing\.value = true/);
  assert.match(workbench, /function stopStoryResourceResize[\s\S]*storyResourceResizing\.value = false/);
  const resizeHandlers = workbench.slice(workbench.indexOf("function startStoryResourceResize"), workbench.indexOf("function resizeStoryResourceWithKeyboard"));
  assert.ok(resizeHandlers.length > 0);
  assert.doesNotMatch(resizeHandlers, /storyResourceLayoutAnimating/);
  assert.doesNotMatch(workbenchStyles, /\.story-resource-layout\.resizing \{\s*transition:/);
});

test("an open sidebar follows window layout width proportionally", () => {
  assert.match(workbench, /const previousLayoutWidth = storyResourceLayoutWidth\.value;[\s\S]*const nextLayoutWidth = entry\?\.contentRect\.width \|\| element\.clientWidth;/);
  assert.match(workbench, /storyResourceSidebar\.visible\.value[\s\S]*storyResourceSidebarProportionalWidth\(storyResourceSidebar\.width\.value, previousLayoutWidth, nextLayoutWidth\)/);
  const layoutObserver = workbench.slice(workbench.indexOf("function observeStoryResourceLayout"), workbench.indexOf("function playStoryResourceLayoutAnimation"));
  assert.ok(layoutObserver.length > 0);
  assert.doesNotMatch(layoutObserver, /storyResourceLayoutAnimating/);
  assert.match(workbenchStyles, /\.story-resource-layout \{\s*[^}]*transition: none;/);
  assert.match(workbenchStyles, /\.story-resource-resize-handle \{\s*[^}]*transition: none;/);
});

test("Story terminal uses instance-scoped cache and only mounts for the active resource", () => {
  assert.match(sidebar, /<SessionPaneContent[\s\S]*v-else-if="activeSession"/);
  assert.match(pane, /<SessionTerminalPreview[\s\S]*v-if="!hasInstanceStatusPage\(instance\) && activeTerminalSocketUrl"[\s\S]*:cache-key="sessionKey"[\s\S]*:cache-scope="instance\.id"/);
  assert.match(workbench, /<StoryResourceSidebar[\s\S]*v-if="storyResourceSidebar\.visible\.value"/);
});

test("resource menu exposes Apps, Files, Review Changes, and Worktrees", () => {
  assert.match(sidebar, /<AppLaunchMenuItems/);
  assert.match(sidebar, /<DropdownMenuContent class="app-launch-menu"/);
  assert.doesNotMatch(sidebar, /submenu-class="story-resource-menu"/);
  assert.match(sidebar, /class="app-launch-menu-item story-resource-menu-item" @select="openTargetRepository\('files'\)"/);
  assert.match(appLaunchMenuItems, /\.app-launch-menu \.app-launch-menu-item span[\s\S]*display: grid;[\s\S]*min-width: 0;/);
  assert.match(appLaunchMenuItems, /\.app-launch-menu \.app-launch-menu-item strong[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(sidebar, /'files'/);
  assert.match(sidebar, /'changes-review'/);
  assert.match(sidebar, /'worktrees'/);
  assert.match(sidebar, /class="app-launch-menu-item story-resource-menu-item" @select="openTargetRepository\('files'\)"/);
  assert.match(sidebar, /:global\(\.app-launch-menu-item\.story-resource-menu-item\)\s*\{\s*min-height:32px;/);
});

test("resource menu targets the current AI Session instance without an instance picker", () => {
  assert.match(workbench, /storyResourceTargetInstance[\s\S]*selection\?\.kind === "session"[\s\S]*instance\.id === selection\.instanceId/);
  assert.match(workbench, /:target-instance="storyResourceTargetInstance"[\s\S]*:target-ai-session-id="storyResourceTargetAiSessionId"/);
  assert.doesNotMatch(sidebar, /DropdownMenuSub v-for="instance in instances"/);
  assert.match(sidebar, /:disabled="!targetInstance \|\| !targetAiSessionId"/);
  assert.match(sidebar, /:cwd-selection="false"/);
  assert.match(sidebar, /targetInstance\?\.aiSessions\.sessions\.find\(\(session\) => session\.id === props\.targetAiSessionId\)/);
  assert.match(sidebar, /emit\("launchApp", props\.targetInstance, appId, undefined, \{ cwd: targetAiSession\.value\.cwd \}\)/);
  assert.doesNotMatch(sidebar, /@new-project|chooseProject/);
  assert.match(sidebar, /emit\("openRepository", props\.targetInstance\.id, "ai-session", props\.targetAiSessionId, page, undefined, targetAiSession\.value\?\.cwdFolderId\)/);
  assert.match(sidebar, /resource\.cwdFolderId \? \{ cwdFolderId: resource\.cwdFolderId \} : \{\}/);
});

test("sidebar ownership is derived from the current AI Session without App Story metadata", () => {
  assert.match(workbench, /useStoryResourceSidebar\(\{[\s\S]*aiSessionId: storyResourceTargetAiSessionId,[\s\S]*instanceId: storyResourceTargetInstanceId/);
  assert.match(workbench, /launchAppSession\(instance\.id, \{[\s\S]*appId,[\s\S]*cwdFolderId/);
  assert.doesNotMatch(workbench, /launchAppSession\(instance\.id, \{[\s\S]{0,200}storyId/);
  assert.doesNotMatch(workbench, /launchStoryResourceApp[\s\S]{0,800}controlPlaneAppSessions\.refetch/);
  assert.doesNotMatch(workbench, /closeStoryResource[\s\S]{0,600}controlPlaneAppSessions\.refetch/);
  assert.match(workbench, /repositoryResource\(aiSessionId, instanceId, sessionKind, sessionId, page, filePath, cwdFolderId\)/);
});

test("Story node filtering does not remove instances from opened resource resolution", () => {
  assert.match(workbench, /<StoryResourceSidebar[\s\S]*:instances="boardInstancesWithAiSessions"/);
  assert.match(workbench, /function openStoryRepositoryResource[\s\S]*boardInstancesWithAiSessions\.value\.some\(\(instance\) => instance\.id === instanceId\)/);
  assert.doesNotMatch(workbench, /const storyResourceInstances|:instances="storyResourceInstances"/);
  assert.doesNotMatch(workbench, /storyResourceInstances\.value\.some/);
});

test("Story embedded browser surfaces use composite keys and hide with the sidebar", () => {
  assert.match(workbench, /key:\s*storyResourceKey\(resource\)[\s\S]*kind:\s*"embedded-browser"/);
  assert.match(workbench, /activeStoryBrowserResource[\s\S]*storyResourceSidebar\.visible\.value[\s\S]*kind === "embedded-browser"/);
  assert.match(workbench, /browserLayerActiveInstanceId[\s\S]*activeStoryBrowserResource\.value\?\.instanceId \|\| ""/);
  assert.match(workbench, /:browser-session-tabs="combinedBrowserSessionTabs"/);
  assert.match(workbench, /closeEmbeddedBrowser:\s*storyResourceSidebar\.removeBrowser/);
  assert.match(sidebar, /supportsBrowserTunnel\(instance\.capabilities\)[\s\S]*supportsDirectoryBrowserTunnel\(instance\.capabilities\)/);
});
