import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("web topbar groups account, settings, and sign-out actions under the user menu", () => {
  const desktopBranch = workbench.slice(workbench.indexOf('<template v-if="desktopBridge">'), workbench.indexOf('<DropdownMenu v-else>'));
  assert.match(desktopBranch, /toggleSettings/);
  assert.doesNotMatch(desktopBranch, /auth\.signOut|signOut|LogOut/);
  assert.match(workbench, /class="control-plane-user-trigger"/);
  assert.match(workbench, /@select="openAccountSecurity"/);
  assert.match(workbench, /<AccountSecurityDialog v-model:open="accountSecurityOpen"/);
  assert.match(workbench, /<DropdownMenuItem @select="openSettings\(\)">/);
  assert.match(workbench, /control-plane-user-menu-sign-out[\s\S]*@select="signOut"/);
  assert.match(workbench, /user\?\.displayName[\s\S]*user\?\.primaryUsername[\s\S]*navigation\.user/);
  assert.match(workbench, /setQueryData\(\["auth-session"\], signedOutAuthSession\(currentSession\)\)/);
  assert.doesNotMatch(workbench, /queryClient\.clear\(\);\s*await queryClient\.invalidateQueries\(\{ queryKey: \["auth-session"\] \}\)/);
});
