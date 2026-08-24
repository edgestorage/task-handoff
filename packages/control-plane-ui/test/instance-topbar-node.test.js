import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const instanceDetail = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.vue", import.meta.url), "utf8");
const sessionPreviewStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.css", import.meta.url), "utf8");

test("instance title appends the authoritative node name as muted metadata", () => {
  assert.match(workbench, /const topbarNodeName = computed\(\(\) => \{\s*if \(standaloneMode\.value && activeInstance\.value\?\.id !== standaloneInstanceId\.value\) return "";\s*return activeInstance\.value\?\.node\?\.name \|\| "";\s*\}\);/);
  assert.match(workbench, /<div v-else class="control-plane-title control-plane-instance-switcher-shell">\s*<span v-if="!standaloneMode" class="control-plane-kicker">\{\{ topbarKicker \}\}<\/span>\s*<DropdownMenu :open="instanceSwitcherOpen"/);
  assert.match(workbench, /<DropdownMenuTrigger as-child>\s*<button[\s\S]*?class="control-plane-instance-switcher"[\s\S]*?<span ref="instanceSwitcherTitleElement" class="control-plane-instance-switcher-title">/);
  assert.match(workbench, /ref="instanceSwitcherElement"[\s\S]*?:data-overflow="instanceSwitcherOverflow \? 'true' : undefined"/);
  assert.match(workbench, /ref="instanceSwitcherTitleElement" class="control-plane-instance-switcher-title"/);
  assert.match(workbench, /<span v-if="standaloneMode" class="control-plane-instance-switcher-icon" aria-hidden="true">\s*<Laptop v-if="topbarRuntimeType === 'local'" :size="14" \/>\s*<Container v-else-if="topbarRuntimeType === 'docker'" :size="14" \/>\s*<Boxes v-else :size="14" \/>/);
  assert.match(workbench, /@pointerdown\.capture="startInstanceSwitcherPointer"[\s\S]*@pointermove="moveInstanceSwitcherPointer"[\s\S]*@pointerup="finishInstanceSwitcherPointer"[\s\S]*@click\.capture="consumeInstanceSwitcherClick"/);
  assert.match(workbench, /Math\.hypot\(event\.screenX - pointer\.startScreenX, event\.screenY - pointer\.startScreenY\) < 5/);
  assert.match(workbench, /if \(!pointer\.moved\) instanceSwitcherOpen\.value = true/);
  assert.match(workbench, /function consumeInstanceSwitcherClick\(event: MouseEvent\)[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopImmediatePropagation\(\);/);
  assert.match(workbench, /<small v-if="topbarNodeName" class="control-plane-instance-node-name" :title="topbarNodeName">· \{\{ topbarNodeName \}\}<\/small>/);
  assert.match(workbench, /const topbarRuntimeType = computed\(\(\) => \{[\s\S]*?activeInstance\.value\?\.id === standaloneInstanceId\.value[\s\S]*?standaloneDirectoryInstance\.value\?\.runtime\.type;/);
  assert.match(workbench, /<ChevronDown class="control-plane-instance-switcher-chevron"/);
  assert.match(workbench, /function syncInstanceSwitcherOverflow\(\) \{[\s\S]*?trigger\.scrollWidth > trigger\.clientWidth \+ 1/);
  assert.match(workbench, /instanceSwitcherResizeObserver = new ResizeObserver\(syncInstanceSwitcherOverflow\);[\s\S]*?observe\(instanceSwitcherElement\.value\)[\s\S]*?observe\(instanceSwitcherTitleElement\.value\)/);
  assert.match(workbench, /<span v-if="standaloneMode && sessionPreviewExpanded && !hasSessionSplit" class="instance-detail-titlebar-divider" aria-hidden="true" \/>\s*<div v-if="standaloneMode" id="instance-detail-titlebar-tabs"/);
  assert.match(workbench, /v-else-if="showNativeWindowControlSpace"[\s\S]*?macos-native-window-control-space[\s\S]*?<div v-if="settingsMode"/);
  assert.match(workbench, /v-else-if="showWindowsNativeWindowControlSpace"[\s\S]*?windows-native-window-control-space/);
  assert.match(styles, /\.control-plane-instance-switcher-shell > \.control-plane-kicker \{[\s\S]*?padding: 0 6px;/);
  assert.match(styles, /\.control-plane-shell \{[\s\S]*?--control-plane-titlebar-height: 56px;/);
  assert.match(styles, /\.control-plane-shell\.standalone-instance-detail \{\s*--control-plane-titlebar-height: 42px;/);
  assert.match(styles, /\.control-plane-shell\.standalone-instance-detail \.control-plane-topbar \{\s*padding-right: 0;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher-shell \{[\s\S]*?display: flex;[\s\S]*?max-width: min\(200px, 28vw\);[\s\S]*?min-width: 100px;[\s\S]*?align-items: center;[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher \{[\s\S]*?--instance-switcher-fade-color: var\(--titlebar-overflow-fade\);[\s\S]*?position: relative;[\s\S]*?width: 100%;[\s\S]*?height: 30px;[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher:focus-visible \{\s*outline: none;/);
  assert.match(sessionPreviewStyles, /\.session-preview-toolbar\.in-titlebar \.session-tab-strip-frame::after \{[\s\S]*?background: linear-gradient\(270deg, var\(--titlebar-overflow-fade\), transparent\);/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher-title > strong \{[\s\S]*?overflow: visible;[\s\S]*?color: var\(--text-muted\);[\s\S]*?font-size: 14px;[\s\S]*?text-overflow: clip;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher::after \{[\s\S]*?width: 14px;[\s\S]*?opacity: 0;[\s\S]*?background: linear-gradient\(to right, transparent, var\(--instance-switcher-fade-color\) 72%\);/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher\[data-overflow="true"\]::after \{\s*opacity: 1;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher:hover::after,[\s\S]*?\.standalone-instance-detail \.control-plane-instance-switcher\[data-state="open"\]::after \{\s*width: 32px;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher-title \{\s*width: max-content;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher-icon \{[\s\S]*?display: inline-flex;[\s\S]*?color: var\(--text-subtle\);/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-switcher-chevron \{[\s\S]*?position: absolute;[\s\S]*?right: 5px;/);
  assert.match(styles, /\.standalone-instance-detail \.control-plane-instance-node-name \{[\s\S]*?overflow: visible;[\s\S]*?color: var\(--text-subtle\);[\s\S]*?text-overflow: clip;/);
  assert.match(styles, /\.instance-detail-titlebar-divider \{[\s\S]*?width: 1px;[\s\S]*?height: 20px;[\s\S]*?margin: 0 8px;[\s\S]*?background: color-mix\(in srgb, var\(--line\) 70%, transparent\);/);
  assert.doesNotMatch(styles, /\.instance-detail-titlebar-tabs \{[^}]*margin-left:/);
  assert.match(styles, /\.instance-detail-titlebar-tabs :deep\(\.session-preview-toolbar\.in-titlebar\) \{[^}]*padding-left: 0;/);
  assert.match(sessionPreviewStyles, /\.session-ai-home \{[\s\S]*?height: 30px;/);
  assert.match(styles, /\.control-plane-workbench \{[\s\S]*?height: calc\(var\(--control-plane-viewport-height\) - var\(--control-plane-titlebar-height\)\);/);
  assert.match(styles, /\.control-plane-instance-switcher-title \{[\s\S]*?align-items: baseline;/);
  assert.match(styles, /\.control-plane-instance-switcher-title > strong \{\s*flex: 0 0 auto;/);
  assert.match(styles, /\.control-plane-instance-node-name \{[\s\S]*?flex: 1 1 0;[\s\S]*?min-width: 0;/);
  assert.match(styles, /\.control-plane-instance-switcher-chevron \{[\s\S]*?align-self: center;/);
  assert.match(styles, /\.control-plane-instance-node-name \{[\s\S]*?color: var\(--text-muted\);[\s\S]*?font-size: 12px;[\s\S]*?text-overflow: ellipsis;/);
  assert.match(styles, /@media \(max-width: 780px\) \{[\s\S]*?\.control-plane-instance-node-name \{\s*display: none;/);
});

test("instance switcher menu exposes each instance's node in a portal-safe layout", () => {
  assert.match(workbench, /<span class="control-plane-instance-menu-copy">[\s\S]*?<strong>\{\{ switcherInstanceName\(instance\) \}\}<\/strong>[\s\S]*?<small>\{\{ switcherNodeName\(instance\) \}\}<\/small>/);
  assert.match(workbench, /const switcherNodeName = [\s\S]*?instance\.node\?\.name \|\| instance\.nodeId/);
  assert.match(workbench, /--instance-menu-height': `\$\{Math\.max\(switcherInstances\.length, 1\) \* 52 - 2\}px`/);
  assert.match(workbench, /:class="\{ selected: instance\.id === selectedInstanceId \}"[\s\S]*?:aria-current="instance\.id === selectedInstanceId \? 'true' : undefined"/);
  assert.match(styles, /:global\(\.control-plane-instance-menu\.control-plane-instance-menu\) \{[\s\S]*?width: max\(var\(--reka-dropdown-menu-trigger-width\), 260px\);[\s\S]*?var\(--reka-dropdown-menu-content-available-width\)[\s\S]*?border-radius: 12px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-copy small\) \{[\s\S]*?color: var\(--text-muted\);[\s\S]*?font-size: 12px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-list\) \{[\s\S]*?padding-right: 0;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-scroll:has\(\[data-orientation="vertical"\]\[data-state="visible"\]\) \.control-plane-instance-menu-list\) \{[\s\S]*?padding-right: 8px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu \.control-plane-instance-menu-item\) \{[\s\S]*?align-items: start;[\s\S]*?padding: 8px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-item\.selected\) \{[\s\S]*?background: var\(--surface-active\);/);
});

test("standalone window identity follows the selected directory entry while scoped detail data loads", () => {
  assert.match(workbench, /const standaloneDirectoryInstance = computed\(\(\) => standaloneMode\.value[\s\S]*?instance\.id === standaloneInstanceId\.value/);
  assert.match(workbench, /const selectedInstanceId = computed\(\(\) => standaloneMode\.value \? standaloneInstanceId\.value : activeInstanceId\.value\);/);
  assert.match(workbench, /const selectedDetail = !standaloneMode\.value \|\| activeInstance\.value\?\.id === standaloneInstanceId\.value[\s\S]*?return selectedDetail\?\.name \|\| standaloneDirectoryInstance\.value\?\.name/);
  assert.match(workbench, /watch\(\s*\[topbarTitle, standaloneInstanceId\][\s\S]*?document\.title = `\$\{topbarTitle\.value\} · TaskHandoff`/);
});

test("standalone switching warms an uncached target before changing the window identity", () => {
  assert.match(workbench, /async function selectInstance\(id: string\)[\s\S]*?const switchSequence = beginInstanceSwitch\(\);\s*try \{\s*await queryClient\.ensureQueryData\(instanceBoardQueryOptions\(id\)\);[\s\S]*?const desktopResult = await switchDesktopInstanceDetailWindow\(id\);[\s\S]*?setActiveInstance\(id\);[\s\S]*?requestAnimationFrame\(\(\) => finishInstanceSwitch\(switchSequence\)\)/);
  assert.match(workbench, /instanceSwitchLoadingTimer = window\.setTimeout\([\s\S]*?instanceSwitchLoadingVisible\.value = true;[\s\S]*?\}, 90\);/);
  assert.match(workbench, /workbenchLoadingOverlayVisible = computed\(\(\) => initialWorkbenchLoadingVisible\.value[\s\S]*?standaloneMode\.value && instanceSwitchLoadingVisible\.value/);
  assert.equal((workbench.match(/showToast\(t\("instances\.window\.focusedExisting"\), "info"\)/g) || []).length, 3);
});

test("initial loading overlay covers both the main workbench and standalone detail before fading out", () => {
  assert.match(workbench, /<Transition name="workbench-loading">[\s\S]*?v-if="workbenchLoadingOverlayVisible"[\s\S]*?class="workbench-loading-overlay"/);
  assert.match(workbench, /<InstanceDetail\s+[\s\S]*?v-else-if="instanceViewMode && !settingsMode && !workbenchLoadingOverlayVisible"/);
  assert.doesNotMatch(instanceDetail, /instances\.detail\.loading/);
  assert.match(instanceDetail, /<section v-else-if="!loading" class="detail-empty">/);
  assert.match(workbench, /const initialWorkbenchLoadingVisible = ref\(true\);[\s\S]*?const initialWorkbenchLoadingFinished = ref\(false\);/);
  assert.match(workbench, /standaloneMode\.value[\s\S]*?\? !standaloneOwnershipResolved\.value \|\| board\.isLoading\.value \|\| standaloneBoardPending\.value[\s\S]*?: board\.isLoading\.value[\s\S]*?window\.requestAnimationFrame\(\(\) => \{\s*initialWorkbenchLoadingVisible\.value = false;/);
  assert.match(workbench, /\{ flush: "post", immediate: true \}/);
  assert.match(workbench, /standaloneMode \? "instances\.detail\.loading" : "instances\.list\.loading"/);
  assert.match(styles, /\.workbench-loading-overlay \{[\s\S]*?background: color-mix\(in srgb, var\(--workspace-bg\) 48%, transparent\);[\s\S]*?backdrop-filter: blur\(2px\);/);
  assert.match(styles, /\.workbench-loading-leave-active \{\s*transition: opacity 110ms ease;/);
  assert.doesNotMatch(styles, /\.workbench-loading-enter-active|\.workbench-loading-enter-from/);
});
