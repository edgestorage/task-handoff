import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settings = fs.readFileSync(new URL("../src/apps/control-plane/settings/SettingsModal.vue", import.meta.url), "utf8");
const users = fs.readFileSync(new URL("../src/apps/control-plane/settings/UserAccessSettingsSection.vue", import.meta.url), "utf8");
const roles = fs.readFileSync(new URL("../src/apps/control-plane/settings/RoleManagementPanel.vue", import.meta.url), "utf8");
const providers = fs.readFileSync(new URL("../src/apps/control-plane/settings/IdentityProviderManagementPanel.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const authGate = fs.readFileSync(new URL("../src/apps/control-plane/AuthGate.vue", import.meta.url), "utf8");
const account = fs.readFileSync(new URL("../src/apps/control-plane/settings/AccountSecurityDialog.vue", import.meta.url), "utf8");
const temporaryPassword = fs.readFileSync(new URL("../src/apps/control-plane/settings/temporaryPassword.ts", import.meta.url), "utf8");
const zhSettings = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/settings.ts", import.meta.url), "utf8");

test("user management navigation consumes the authoritative permission projection", () => {
  assert.match(settings, /permissionIds\.includes\("users:manage"\)/);
  assert.match(settings, /canManageUsers[\s\S]*id: "users"/);
  assert.doesNotMatch(settings, /user\?\.role|role !== "admin"/);
  assert.match(workbench, /useCurrentAccessQuery/);
  assert.match(workbench, /preserveAcrossAuthorizationChange/);
  assert.doesNotMatch(workbench, /hiddenNodeIds|deniedNodeIds|roleAllows/);
});

test("temporary-password sessions are kept behind the password-change gate", () => {
  assert.match(authGate, /authenticated && !authSession\.data\.value\.requiresPasswordChange/);
  assert.match(authGate, /changeControlPlanePassword/);
  assert.match(authGate, /currentPassword/);
  assert.match(authGate, /newPassword/);
});

test("user management edits the user, role, node, and instance scope source models", () => {
  assert.match(users, /createControlPlaneUser/);
  assert.match(users, /setControlPlaneUserAccess/);
  assert.match(users, /updateControlPlaneUser/);
  assert.match(users, /expectedAuthorizationRevision/);
  assert.match(users, /accessGrant\.instanceScope/);
  assert.match(users, /inherit-node-scope/);
  assert.match(users, /class="scope-tree" role="tree"/);
  assert.match(users, /scopeTreeNodes/);
  assert.ok(users.indexOf('settings.userAccess.allNodes') < users.indexOf('settings.userAccess.inheritNodeInstances'));
  assert.match(settings, /:instances="instances"/);
  assert.doesNotMatch(users, /Collaboration|Membership|inviteToken/);
});

test("personal account opens outside settings while administrator management remains permission-gated", () => {
  assert.match(zhSettings, /navigation: "我的账号"/);
  assert.match(zhSettings, /context: "管理员功能"/);
  assert.match(account, /settings\.account\.title/);
  assert.match(account, /<Dialog :open="open"/);
  assert.match(users, /settings\.userAccess\.context/);
  assert.doesNotMatch(settings, /id: "account"/);
  assert.match(workbench, /@select="openAccountSecurity"/);
  assert.ok(settings.indexOf('id: "mobile-sessions"') < settings.indexOf('id: "users"'));
});

test("access management UI covers user security, custom roles, providers, and approvals", () => {
  assert.match(users, /listControlPlaneUserSessions/);
  assert.match(users, /resetControlPlaneUserPassword/);
  assert.doesNotMatch(users, /bindControlPlaneUserIdentity|identityDraft|bindIdentity/);
  assert.match(users, /unbindControlPlaneUserExternalIdentity/);
  assert.match(users, /v-if="identity\.kind !== 'local-password'"/);
  assert.match(users, /effectivePermissions/);
  assert.match(users, /accessDraft\.roleIds/);
  assert.match(roles, /usePermissionsQuery/);
  assert.match(roles, /archiveControlPlaneRole/);
  assert.match(providers, /createControlPlaneIdentityProvider/);
  assert.match(providers, /approveControlPlaneExternalIdentity/);
  assert.match(providers, /AlertDialog/);
  assert.match(users, /class="user-detail-close"/);
  assert.match(users, /t\('common\.actions\.close'\)/);
});

test("access management sub-navigation stays compact inside its grid layout", () => {
  assert.match(users, /\.access-tabs-list\{[^}]*justify-self:start[^}]*width:fit-content/);
});

test("user access follows the shared settings page and directory layout", () => {
  assert.match(users, /class="user-access-scroll"/);
  assert.match(users, /class="user-access-settings"/);
  assert.match(users, /class="user-access-head"/);
  assert.match(users, /\.user-access-settings\{[^}]*var\(--settings-content-max-width,1080px\)/);
  assert.match(users, /\.access-tab-content\{[^}]*background:var\(--surface-raised\)[^}]*border:1px solid var\(--line\)/);
  assert.doesNotMatch(users, /settings-panel-surface|modal-section/);
});

test("user profile and effective permission details use focused dialogs", () => {
  assert.match(users, /profileOpen/);
  assert.match(users, /profileUsername/);
  assert.match(users, /username: profileUsername\.value\.trim\(\)/);
  assert.match(users, /permissionSummary/);
  assert.match(users, /effectivePermissionGroups/);
  assert.match(users, /class="z-\[60\] permission-dialog"/);
  assert.match(users, /overlay-class="z-\[60\]"/);
  assert.doesNotMatch(users, /<div class="inline-form"><Input v-model="profileName"/);
  assert.doesNotMatch(users, /class="permission-preview"/);
});

test("password reset is a focused random-password dialog", () => {
  assert.match(users, /passwordResetOpen/);
  assert.match(users, /generateTemporaryPassword/);
  assert.match(temporaryPassword, /crypto\.getRandomValues/);
  assert.match(temporaryPassword, /byte % TEMPORARY_PASSWORD_ALPHABET\.length/);
  assert.match(users, /settings\.userAccess\.passwordReset\.confirm/);
  assert.doesNotMatch(users, /<Input v-model="newPassword" type="password"/);
});
