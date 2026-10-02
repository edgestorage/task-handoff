import assert from "node:assert/strict";
import test from "node:test";
import { appLaunchIconKind } from "../src/apps/control-plane/shared/appLaunchIcon.ts";

test("launcher icons follow inventory kind, automation, and agent identity", () => {
  assert.equal(appLaunchIconKind({ id: "terminal-tty", kind: "tty" }), "terminal");
  assert.equal(appLaunchIconKind({ id: "terminal-gui", kind: "gui" }), "desktop");
  assert.equal(appLaunchIconKind({ id: "chromium", kind: "gui", automation: "cdp" }), "browser");
  assert.equal(appLaunchIconKind({ id: "vscode-web", kind: "web" }), "web");
  assert.equal(appLaunchIconKind({ id: "codex", kind: "tty", agent: true }), "agent");
  assert.equal(appLaunchIconKind({ id: "codex", kind: "tty" }), "agent");
  assert.equal(appLaunchIconKind({ id: "embedded-browser" }), "browser");
  assert.equal(appLaunchIconKind({ id: "custom-app" }), "generic");
});
