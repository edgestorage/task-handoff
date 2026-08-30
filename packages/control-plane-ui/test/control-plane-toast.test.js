import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const toasts = fs.readFileSync(new URL("../src/apps/control-plane/useControlPlaneToasts.ts", import.meta.url), "utf8");
const sessionPanel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const sessionBoard = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");

test("control-plane toast semantics include informational outcomes", () => {
  assert.match(toasts, /ControlPlaneToastKind = "error" \| "info" \| "success"/);
  assert.match(toasts, /toast\[kind\]\(message/);
});

test("long-running session actions use a delayed loading toast", () => {
  assert.match(toasts, /CONTROL_PLANE_LOADING_TOAST_DELAY_MS = 800/);
  assert.match(toasts, /toast\.loading\(message, \{ duration: Infinity, closeButton: false \}\)/);
  assert.match(toasts, /globalThis\.clearTimeout\(timer\)/);
  assert.match(toasts, /toast\.dismiss\(toastId\)/);

  for (const source of [sessionPanel, sessionBoard]) {
    assert.match(source, /showDelayedControlPlaneLoadingToast\(t\("sessions\.actions\.closingSession"\)\)/);
    assert.match(source, /showDelayedControlPlaneLoadingToast\(t\("sessions\.actions\.forking"\)\)/);
    assert.match(source, /loadingToast\.dismiss\(\)/);
  }
});
