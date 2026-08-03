import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { sessionFrameUrl } from "../src/apps/control-plane/useInstanceSessions.ts";

const read = (path) => fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");

const workbench = read("ControlPlaneWorkbench.vue");
const board = read("board/InstanceBoardView.vue");
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

test("board empty states use the themed inset surface", () => {
  assert.match(board, /\.board-empty \{[\s\S]*?background: var\(--surface-inset\);/);
  assert.doesNotMatch(board, /\.board-empty \{[\s\S]*?background: var\(--white\);/);
});

test("mobile board groups flow directly into a single card column", () => {
  assert.match(board, /@media \(max-width: 780px\) \{[\s\S]*?\.instance-board-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.doesNotMatch(board, /@media \(max-width: 780px\) \{[\s\S]*?grid-auto-rows:/);
});
