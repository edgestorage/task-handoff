import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("composer supports generic files and Local Runtime path references", () => {
  const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
  assert.match(composer, /kind: "image" \| "file"/);
  assert.match(composer, /MAX_INLINE_FILE_BYTES = 500 \* 1024/);
  assert.match(composer, /file\.size >= MAX_INLINE_FILE_BYTES/);
  assert.match(composer, /runtimePathAccess === "desktop-local"/);
  assert.match(composer, /runtimePathWithinWorkspace\(filePath, props\.mentionContext\.cwd\)/);
  assert.match(composer, /t\("sessions\.composer\.runtimePathOutside"\)/);
  assert.match(composer, /showControlPlaneToast\(outsideWorkspaceFiles\.has\(file\)/);
  assert.doesNotMatch(composer, /ai-session-composer__error/);
  assert.match(composer, /source: \{ type: "runtime-path", path: runtimePath \}/);
  assert.match(composer, /attachment\.kind === 'file'/);
});

test("desktop runtime paths are limited to the control-plane local node", () => {
  const mentions = fs.readFileSync(new URL("../src/components/ai-session/useAiSessionMentions.ts", import.meta.url), "utf8");
  const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
  assert.match(mentions, /instance\.runtime\?\.type === "local"/);
  assert.match(mentions, /instance\.node\?\.labels\[CONTROL_PLANE_LOCAL_NODE_LABEL\] === "true"/);
  assert.match(board, /runtimePathAccess: desktopRuntimePathAccess\(card\.instance\)/);
  assert.match(panel, /runtimePathAccess: desktopRuntimePathAccess\(props\.instance\)/);
});

test("desktop preload exposes Electron's supported File path bridge", () => {
  const preload = fs.readFileSync(new URL("../../../apps/desktop-shell/src/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /webUtils/);
  assert.match(preload, /getPathForFile: \(file\) => webUtils\.getPathForFile\(file\)/);
});
