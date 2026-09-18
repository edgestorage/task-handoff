import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.css", import.meta.url), "utf8");
const detail = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.vue", import.meta.url), "utf8");

test("desktop instance summary compacts identity while keeping status and actions on separate rows", () => {
  assert.match(detail, /class="detail-meta"[\s\S]*?<Folder :size="14"[\s\S]*?instanceSourceLabel\(instance, t\)[\s\S]*?<Package :size="14"[\s\S]*?<Server :size="14"[\s\S]*?<Box :size="14"/);
  assert.match(detail, /<ContextMenu v-if="canOpenInstanceSourceFolder">[\s\S]*?class="detail-meta-folder" @click="openInstanceSourceFolder"[\s\S]*?<ContextMenuItem[^>]*@select="openInstanceSourceFolder"/);
  assert.match(detail, /desktopRuntimePathAccess\(props\.instance\) === "desktop-local"[\s\S]*?canOpenDesktopLocalPath\(\)[\s\S]*?openDesktopLocalPath\(instanceSourceLocation\(instance\)\)/);
  assert.match(detail, /class="instance-detail-meta-tooltip"[\s\S]*?instanceSourceLocation\(instance\)[\s\S]*?instanceImageTooltip\(instance\)[\s\S]*?instance\.nodeId[\s\S]*?instanceRuntimeTooltip\(instance\)/);
  assert.match(styles, /\.instance-detail\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*padding: 14px;/s);
  assert.match(styles, /\.detail-head\s*\{[^}]*align-items: center;[^}]*margin-bottom: 10px;/s);
  assert.match(styles, /\.detail-side\s*\{[^}]*display: grid;[^}]*justify-items: end;/s);
  assert.match(styles, /\.detail-meta\s*\{[^}]*font-size: 13px;[^}]*line-height: 20px;/s);
  assert.match(styles, /\.detail-meta-item\s*\{[^}]*display: inline-flex;[^}]*gap: 5px;/s);
  assert.match(styles, /\.instance-controls\s*\{[^}]*flex-wrap: nowrap;/s);
  assert.doesNotMatch(styles, /\.instance-controls\s*\{[^}]*max-width:\s*420px;/s);
  assert.match(styles, /\.instance-controls\.compact > button\s*\{[^}]*width: 32px;[^}]*min-width: 32px;[^}]*padding: 0;/s);
  assert.match(styles, /\.instance-controls\.compact > button > \.instance-action-label\s*\{[^}]*width: 1px;[^}]*clip-path: inset\(50%\);/s);
  assert.match(detail, /<TooltipProvider :delay-duration="120">[\s\S]*?class="instance-controls"[\s\S]*?<TooltipContent side="bottom">/);
  assert.match(detail, /function instanceControlsOverflowWidth\(\)[\s\S]*?controls\.scrollWidth - controls\.clientWidth[\s\S]*?controls\.getBoundingClientRect\(\)\.right - head\.getBoundingClientRect\(\)\.right/);
  assert.match(detail, /new ResizeObserver\(\(\) => scheduleInstanceControlsLayout\(\)\)/);
  assert.match(detail, /instanceControlsExpandAtWidth = headWidth \+ Math\.ceil\(overflowWidth\) \+ 8/);
  assert.doesNotMatch(styles, /@container \(max-width: 1280px\)/);
});

test("mobile instance summary uses a compact two-row layout", () => {
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.instance-detail\s*\{[^}]*padding: 8px;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.instance-detail-layout\s*\{[^}]*height: 100%;[^}]*min-height: 0;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.detail-head\s*\{[^}]*gap: 8px;[^}]*margin-bottom: 8px;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.detail-head\s*\{[^}]*align-items: start;/);
  assert.match(styles, /\.detail-name-button,\s*\.detail-name-input\s*\{[^}]*font-size: 20px;/s);
  assert.match(styles, /\.detail-side\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*justify-content: space-between;/s);
});

test("mobile instance actions stay accessible while rendering as icon buttons", () => {
  assert.match(styles, /\.instance-controls > button\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*padding: 0;/s);
  assert.match(styles, /\.instance-controls > button > span\s*\{[^}]*width: 1px;[^}]*clip-path: inset\(50%\);[^}]*white-space: nowrap;/s);
});

test("instance inline rename leaves Enter and Escape to an active IME composition", () => {
  assert.match(detail, /@keydown="handleNameEditKeydown"/);
  assert.match(detail, /function handleNameEditKeydown\(event: KeyboardEvent\) \{[\s\S]*?if \(event\.isComposing\) return;[\s\S]*?event\.key === "Enter"[\s\S]*?commitNameEdit\(\)[\s\S]*?event\.key === "Escape"[\s\S]*?cancelNameEdit\(\)/);
  assert.doesNotMatch(detail, /class="detail-name-input"[^>]*@keydown\.(?:enter|esc)\.prevent/);
});
