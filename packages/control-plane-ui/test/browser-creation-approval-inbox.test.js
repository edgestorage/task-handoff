import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");
}

test("browser creation no longer uses a per-request approval inbox", () => {
  const inbox = source("action-inbox/ActionInbox.vue");
  const items = source("action-inbox/items.ts");
  const workbench = source("ControlPlaneWorkbench.vue");
  const events = source("useControlPlaneEvents.ts");
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");

  assert.doesNotMatch(inbox, /browser-creation/);
  assert.doesNotMatch(items, /browser-creation|BrowserCreationInboxItem/);
  assert.doesNotMatch(workbench, /useBrowserCreationApprovals|claimActionInboxBrowserCreation|declineActionInboxBrowserCreation/);
  assert.doesNotMatch(workbench, /claim-browser-creation=|decline-browser-creation=/);
  assert.doesNotMatch(browser, /creationApprovals|listBrowserCreationApprovals|claimBrowserCreation\(|declineBrowserCreation\(/);
  assert.equal(fs.existsSync(new URL("../src/apps/control-plane/action-inbox/browserCreationItems.ts", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../src/apps/control-plane/action-inbox/useBrowserCreationApprovals.ts", import.meta.url)), false);
  assert.match(events, /event\.type === "browser\.creation-context\.changed" \|\| event\.type === "browser\.creation\.changed"/);
  assert.match(events, /BROWSER_CREATION_CONTEXT_CHANGED_EVENT/);
});

test("the browser Agent access popover owns panel listing and default switching", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");

  assert.match(browser, /getBrowserCreationContext\(props\.instanceId, browserSourceRef\.value\)/);
  assert.match(browser, /claimBrowserCreationContext\(props\.instanceId, panel\.sourceRef, snapshot\.revision\)/);
  assert.match(browser, /revokeBrowserCreationContext\(props\.instanceId, panel\.sourceRef, snapshot\.revision\)/);
  assert.match(browser, /v-for="panel in creationPanels"/);
  assert.match(browser, /canClaimCreationPanel\(panel\)/);
  assert.match(browser, /isOwnCreationPanel\(panel\) && panel\.canClaim && panel\.canCreate && !panel\.isDefault/);
  assert.match(browser, /!browserSourceRef[\s\S]*?creationContextWebReadOnly/);
  assert.match(browser, /embedded-browser-creation-context-takenOver|creationContextTakenOver/);
});
