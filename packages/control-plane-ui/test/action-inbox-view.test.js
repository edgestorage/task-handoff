import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const inbox = fs.readFileSync(new URL("../src/apps/control-plane/action-inbox/ActionInbox.vue", import.meta.url), "utf8");

test("collapsed entry appears between the user/settings control and the right sidebar", () => {
  const userMenu = workbench.indexOf('<DropdownMenu v-else>');
  const collapsedIcon = workbench.indexOf('v-if="!standaloneMode && actionInboxCollapsed"');
  const sidebar = workbench.indexOf('<PanelRight :size="16"');
  assert.ok(userMenu < collapsedIcon && collapsedIcon < sidebar);
  assert.match(workbench, /class="control-plane-icon-button action-inbox-trigger"[\s\S]*:class="\{ 'action-inbox-trigger-empty': !actionInboxItems\.length \}"/);
  assert.match(workbench, /@click="expandActionInbox"/);
  assert.match(workbench, /function expandActionInbox\(\) \{\s*if \(!actionInboxItems\.value\.length && !actionInboxError\.value\) return;/);
  assert.match(workbenchStyles, /\.control-plane-actions \.control-plane-icon-button\.inline-flex\s*\{[\s\S]*border:\s*1px solid transparent;/);
  assert.match(workbenchStyles, /\.action-inbox-trigger-count\s*\{[\s\S]*position:\s*absolute;[\s\S]*border-radius:\s*999px;/);
  assert.match(workbench, /<ActionInbox v-if="!standaloneMode"[^>]*@collapse="actionInboxCollapsed = true"/);
});

test("expanded inbox renders only with content and keeps one group-level collapse button", () => {
  assert.match(inbox, /<aside v-if="!collapsed && \(items\.length \|\| error\)" class="action-inbox"/);
  assert.doesNotMatch(inbox, /action-inbox-empty/);
  assert.match(inbox, /class="action-inbox-collapse"/);
  assert.match(inbox, /v-for="item in visibleItems"/);
  assert.match(inbox, /v-if="items.length > visibleCount"[^>]*:aria-label=/);
  assert.match(inbox, /\.action-inbox \{ position: fixed;/);
});

test("operation cards show a label for every protected action and only server-supplied safe details", () => {
  for (const operation of ["instance.delete", "node.remove", "node.update.apply", "node.external-listener.set", "user.access.set", "user.role.update", "user.role.remove", "identity-provider.update", "identity-provider.remove", "git-credential.assign"]) {
    assert.ok(inbox.includes(`"${operation}": "navigation.`), operation);
  }
  assert.match(inbox, /v-for="detail in item\.request\.details"/);
  assert.doesNotMatch(inbox, /preflightToken|clientSecret/);
});
