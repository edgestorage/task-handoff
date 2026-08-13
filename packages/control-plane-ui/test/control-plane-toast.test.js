import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const toasts = fs.readFileSync(new URL("../src/apps/control-plane/useControlPlaneToasts.ts", import.meta.url), "utf8");

test("control-plane toast semantics include informational outcomes", () => {
  assert.match(toasts, /ControlPlaneToastKind = "error" \| "info" \| "success"/);
  assert.match(toasts, /toast\[kind\]\(message/);
});
