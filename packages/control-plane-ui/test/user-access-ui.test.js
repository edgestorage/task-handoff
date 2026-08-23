import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settings = fs.readFileSync(new URL("../src/apps/control-plane/settings/SettingsModal.vue", import.meta.url), "utf8");
const users = fs.readFileSync(new URL("../src/apps/control-plane/settings/UserAccessSettingsSection.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("user management navigation consumes the authoritative permission projection", () => {
  assert.match(settings, /permissionIds\.includes\("users:manage"\)/);
  assert.match(settings, /canManageUsers[\s\S]*id: "users"/);
  assert.doesNotMatch(settings, /user\?\.role|role !== "admin"/);
  assert.match(workbench, /useCurrentAccessQuery/);
  assert.match(workbench, /preserveAcrossAuthorizationChange/);
  assert.doesNotMatch(workbench, /hiddenNodeIds|deniedNodeIds|roleAllows/);
});

test("user management edits the user, role, and node-scope source models", () => {
  assert.match(users, /createControlPlaneUser/);
  assert.match(users, /setControlPlaneUserAccess/);
  assert.match(users, /updateControlPlaneUser/);
  assert.match(users, /expectedAuthorizationRevision/);
  assert.doesNotMatch(users, /Collaboration|Membership|inviteToken/);
});
