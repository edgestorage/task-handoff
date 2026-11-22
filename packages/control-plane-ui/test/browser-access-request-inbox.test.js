import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");
}

test("Agent browser access requests are approved from the shared approval center", () => {
  const inbox = source("action-inbox/ActionInbox.vue");
  const items = source("action-inbox/items.ts");
  const store = source("action-inbox/useBrowserAccessRequests.ts");
  const workbench = source("ControlPlaneWorkbench.vue");
  const events = source("useControlPlaneEvents.ts");
  const api = fs.readFileSync(new URL("../src/api/browserControl.ts", import.meta.url), "utf8");

  assert.match(inbox, /item\.type === 'browser-access-request'/);
  assert.match(inbox, /decide-browser-access/);
  assert.match(items, /BrowserAccessRequestItem/);
  assert.match(store, /getBrowserControlAccess\(instance\.id\)/);
  assert.match(store, /grantBrowserControlAccess\(item\.instanceId, \{/);
  assert.match(store, /denyBrowserControlAccessRequest/);
  assert.match(store, /BROWSER_ACCESS_REQUEST_CHANGED_EVENT/);
  assert.match(workbench, /useBrowserAccessRequests\(\(\) => boardInstancesWithAiSessions\.value, \(\) => !standaloneMode\.value\)/);
  assert.match(workbench, /decideActionInboxBrowserAccess/);
  assert.match(events, /event\.type === "browser\.access\.request\.changed"/);
  assert.match(api, /access-requests\/\$\{encodeURIComponent\(requestRef\)\}\/deny/);
});

test("choosing the first default creation panel also grants instance browser access", () => {
  const browser = source("instance-detail/EmbeddedBrowserTab.vue");
  assert.match(browser, /await claimBrowserCreationContext\(props\.instanceId, panel\.sourceRef, snapshot\.revision\)/);
  assert.match(browser, /!browserControlAccess\.value\.active[\s\S]*?grantBrowserControlAccess\(props\.instanceId\)/);
});
