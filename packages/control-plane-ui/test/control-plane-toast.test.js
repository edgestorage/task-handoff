import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const toasts = fs.readFileSync(new URL("../src/apps/control-plane/useControlPlaneToasts.ts", import.meta.url), "utf8");
const toastSurface = fs.readFileSync(new URL("../src/components/ui/sonner/Sonner.vue", import.meta.url), "utf8");
const sessionPanel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const sessionBoard = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");

test("control-plane toast semantics include informational outcomes", () => {
  assert.match(toasts, /ControlPlaneToastKind = "error" \| "info" \| "success"/);
  assert.match(toasts, /toast\[kind\]\(message/);
});

test("control-plane toasts support persistent user actions", () => {
  assert.match(toasts, /ControlPlaneToastOptions/);
  assert.match(toasts, /duration: options\.duration \?\? 6000/);
  assert.match(toasts, /options\.action \? \{ action: options\.action \}/);
  assert.match(toastSurface, /\.task-handoff-toast\[data-sonner-toast\][\s\S]*?width: 100%;/);
  assert.match(toastSurface, /\.task-handoff-toast-action,[\s\S]*?grid-column: 2;/);
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
