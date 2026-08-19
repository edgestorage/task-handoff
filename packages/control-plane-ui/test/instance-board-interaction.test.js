import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { sessionFrameUrl } from "../src/apps/control-plane/useInstanceSessions.ts";

const read = (path) => fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");

const workbench = read("ControlPlaneWorkbench.vue");
const board = read("board/InstanceBoardView.vue");
const boardSessions = read("board/useInstanceBoardSessions.ts");
const detailSelection = read("instance-detail/instanceDetailSelection.ts");
const appLaunchItems = read("shared/AppLaunchMenuItems.vue");
const appLaunchIcon = read("shared/AppLaunchIcon.vue");
const options = read("shared/InstanceViewOptionsMenu.vue");
const terminal = read("board/useBoardTerminalPreviews.ts");

const vncInstance = { id: "instance/vnc" };
const vncSession = {
  key: "gui-session",
  kind: "browser",
  label: "GUI",
  status: "running",
  source: { id: "gui/session", kind: "gui" },
};

test("board preview interaction defaults to read-only and persists the explicit preference", () => {
  assert.match(workbench, /const BOARD_INTERACTIVE_STORAGE_KEY = "task-handoff\.control-plane\.board-interactive"/);
  assert.match(workbench, /getItem\(BOARD_INTERACTIVE_STORAGE_KEY\) === "true"/);
  assert.match(workbench, /const boardInteractive = ref\(storedBoardInteractive\(\)\)/);
  assert.match(workbench, /watch\(boardInteractive,[\s\S]*setItem\(BOARD_INTERACTIVE_STORAGE_KEY, String\(interactive\)\)/);
});

test("board options expose one interaction switch and apply it to every live preview", () => {
  assert.match(board, /:preview-interactive="interactive"/);
  assert.match(board, /@update:preview-interactive="\$emit\('update:interactive', \$event\)"/);
  assert.match(options, /t\("instances\.viewOptions\.interactWithPreviews"\)/);
  assert.match(board, /class="board-card-preview" :data-interactive="interactive"/);
  assert.match(board, /data-interactive="false"\][\s\S]*\.board-card-frame,[\s\S]*data-interactive="false"\][\s\S]*\.board-terminal-preview[\s\S]*pointer-events: none/);
});

test("interactive board terminals use the existing terminal input protocol", () => {
  assert.match(terminal, /disableStdin: !terminalInteractive/);
  assert.match(terminal, /if \(terminalInteractive\) \{[\s\S]*terminal\.onData\(\(data\) => \{[\s\S]*socket\.send\(JSON\.stringify\(\{ type: "input", data \}\)\)/);
  assert.match(terminal, /existing\?\.url === target\.url && existing\.interactive === interactive\.value/);
  assert.match(terminal, /generation !== boardTerminalGenerations\.get\(instanceId\)[\s\S]*interactive\.value !== terminalInteractive/);
  assert.match(workbench, /useBoardTerminalPreviews\(boardMode, boardInteractive\)/);
});

test("board VNC URLs follow the same authoritative interaction state", () => {
  const readOnlyUrl = new URL(sessionFrameUrl(vncInstance, vncSession, { compact: true }), "http://control-plane.test");
  const interactiveUrl = new URL(sessionFrameUrl(vncInstance, vncSession, { compact: true, interactive: true }), "http://control-plane.test");

  assert.equal(readOnlyUrl.searchParams.get("view_only"), "1");
  assert.equal(interactiveUrl.searchParams.has("view_only"), false);
  assert.equal(interactiveUrl.searchParams.get("path"), "instances/instance%2Fvnc/api/apps/sessions/gui/session/web/websockify");
  assert.match(workbench, /useInstanceBoardSessions\(\{ boardInteractive, boardSessionKeys, boardVisibleInstances, locale, t \}\)/);
});

test("instance board cards keep App and AI in the session menu and slide individual AI sessions", () => {
  assert.match(boardSessions, /key: "ai-sessions"/);
  assert.match(boardSessions, /return aiSessionTab \? \[\.\.\.appSessions, aiSessionTab\] : appSessions/);
  assert.match(boardSessions, /function selectBoardSession[\s\S]*boardSessionKeys\[instanceId\] = sessionKey/);
  assert.match(boardSessions, /function stepBoardAiSession[\s\S]*boardAiSessionKeys\[instance\.id\] = next\.id/);
  assert.match(board, /<DropdownMenu>[\s\S]*v-for="session in boardSessions\(instance\)"[\s\S]*selectBoardSession/);
  assert.match(board, /instances\.board\.previousAiSession/);
  assert.match(board, /instances\.board\.nextAiSession/);
  assert.match(board, /boardPrimaryAiSession\(instance\)/);
  assert.match(board, /class="board-ai-slide board-ai-slide-previous"/);
  assert.match(board, /class="board-ai-slide board-ai-slide-next"/);
  assert.match(board, /\.board-ai-slide \{[\s\S]*position: absolute;[\s\S]*opacity: 0;[\s\S]*backdrop-filter: blur\(8px\)/);
  assert.match(board, /\.board-ai-preview:hover \.board-ai-slide,[\s\S]*opacity: 0\.72/);
  assert.match(board, /\.board-ai-card-head strong \{[\s\S]*var\(--ai-board-muted\)[\s\S]*font-size: 13px;[\s\S]*font-weight: 700/);
  assert.doesNotMatch(board, /board-ai-card-head[\s\S]{0,500}sessions\.board\.updated/);
  assert.match(board, /\.board-ai-question \{[\s\S]*color: var\(--ai-board-title\);[\s\S]*font-size: 14px;[\s\S]*line-height: 1\.35/);
  assert.match(board, /\.board-ai-answer \{[\s\S]*background: var\(--ai-session-card-content-bg\);[\s\S]*color: var\(--ai-board-title\);[\s\S]*font-size: 14px;[\s\S]*font-weight: 400;[\s\S]*line-height: 1\.35/);
});

test("each instance board card opens its current session in the instance detail window", () => {
  assert.match(board, /<Button variant="outline" size="sm" @click="\$emit\('openWindow', instance, boardPrimarySession\(instance\), boardPrimaryAiSession\(instance\)\)">[\s\S]*?instances\.actions\.open/);
  assert.match(board, /openWindow: \[instance: InstanceWithAiSessions, session\?: BoardSessionTab, aiSession\?: AiSessionSummary\]/);
  assert.doesNotMatch(board, /boardOpenUrl|\$emit\('openUrl'/);
  assert.match(workbench, /<InstanceBoardView[\s\S]*?@open-window="openInstanceWindow"/);
  assert.match(workbench, /session\?\.kind === "ai" && aiSession[\s\S]*persistInstanceDetailSelection\(instance\.id, \{ kind: "ai", aiSessionId: aiSession\.id \}\)/);
  assert.match(workbench, /persistInstanceDetailSelection\(instance\.id, \{ kind: "app", sessionKey: session\.key \}\)/);
  assert.match(workbench, /selectAiSession\(instanceId, selection\.aiSessionId\);\s*selectSession\("ai-sessions"\)/);
  assert.match(workbench, /selectSession\(selection\.sessionKey\)/);
  assert.match(detailSelection, /localStorage\?\.removeItem\(key\)/);
  assert.doesNotMatch(workbench, /:board-open-url=/);
});

test("board empty states use the themed inset surface", () => {
  assert.match(board, /\.board-empty \{[\s\S]*?background: var\(--surface-inset\);/);
  assert.doesNotMatch(board, /\.board-empty \{[\s\S]*?background: var\(--white\);/);
});

test("board app launch menus keep parent and project flyout layouts consistent", () => {
  assert.match(board, /<AppLaunchMenuItems[\s\S]*?submenu-class="board-launch-menu"/);
  assert.match(appLaunchItems, /<DropdownMenuSubContent :class="submenuClass \|\| 'app-launch-menu'">/);
  assert.match(board, /:global\(\.board-launch-menu \.app-launch-menu-item\) \{[\s\S]*?grid-template-columns: 18px minmax\(0, 1fr\) 16px;/);
  assert.match(board, /:global\(\.board-launch-menu \.app-launch-menu-item span\) \{[\s\S]*?display: grid;[\s\S]*?gap: 2px;/);
  assert.doesNotMatch(board, /board-launch-menu-item/);
});

test("app launch menus use product and terminal icons instead of a generic launch glyph", () => {
  assert.match(appLaunchItems, /<AppLaunchIcon :app-id="app\.id" \/>/);
  assert.match(appLaunchIcon, /terminalAppIds = new Set\(\["terminal", "terminal-tty", "gui-terminal"\]\)/);
  assert.match(appLaunchIcon, /<AiAgentIcon v-if="agent"/);
  assert.match(appLaunchIcon, /<SquareTerminal v-else-if=/);
  assert.match(appLaunchIcon, /<Play v-else/);
});

test("mobile board groups flow directly into a single card column", () => {
  assert.match(board, /@media \(max-width: 780px\) \{[\s\S]*?\.instance-board-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.doesNotMatch(board, /@media \(max-width: 780px\) \{[\s\S]*?grid-auto-rows:/);
});
