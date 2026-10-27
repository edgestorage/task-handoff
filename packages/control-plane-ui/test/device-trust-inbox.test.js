import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyDeviceTrustSnapshot, shouldRecoverDeviceTrust } from "../src/apps/control-plane/action-inbox/deviceTrustState.ts";
import { deviceTrustInboxItems, mergeActionInboxItems } from "../src/apps/control-plane/action-inbox/items.ts";
import { createDeviceTrustStore } from "../src/apps/control-plane/action-inbox/deviceTrustStore.ts";

const root = new URL("../src/apps/control-plane/", import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, root), "utf8");

function request(id, status, requestedAt = "2026-01-02T00:00:00.000Z") {
  return {
    source: "control-plane-device",
    requestId: id,
    status,
    reason: "first-seen",
    device: { name: `Device ${id}`, kind: "mobile", platform: "android", version: "1.0.0" },
    fingerprint: `sha256:${"A".repeat(43)}`,
    comparisonCode: "AAAA-BBBB-CCCC-DDDD",
    bindingId: "binding_a",
    accountId: "account-a",
    ownerAccountId: "owner-a",
    accessMode: "shared",
    shareGrantId: "share-a",
    cloudAccessRoleId: "role-cloud",
    requestedAt,
    lastSeenAt: requestedAt,
    expiresAt: "2026-01-03T00:00:00.000Z",
    revision: 1,
  };
}

test("device trust projects only pending requests into the shared approval inbox", () => {
  const roles = [{ roleId: "role-admin", name: "Admin", status: "active", isAdmin: true }];
  const snapshot = {
    revision: 7,
    requests: [request("pending", "pending"), request("approved", "approved", "2026-01-03T00:00:00.000Z")],
    trustedDevices: [],
    roles,
  };
  const items = deviceTrustInboxItems(snapshot);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "device-trust:pending");
  assert.equal(items[0].request.status, "pending");
  assert.deepEqual(items[0].roles, roles);
  assert.deepEqual(mergeActionInboxItems([], [], [], snapshot).map((item) => item.key), ["device-trust:pending"]);
});

test("device trust events recover only a newer revision for the current binding", () => {
  const current = applyDeviceTrustSnapshot({ revision: -1, requests: [], trustedDevices: [], roles: [] }, {
    revision: 4,
    requests: [request("pending", "pending")],
    trustedDevices: [],
    roles: [],
  });
  assert.equal(shouldRecoverDeviceTrust(current, { bindingId: "binding_a", revision: 5 }), true);
  assert.equal(shouldRecoverDeviceTrust(current, { bindingId: "binding_a", revision: 4 }), false);
  assert.equal(shouldRecoverDeviceTrust(current, { bindingId: "binding_b", revision: 5 }), false);
  assert.equal(shouldRecoverDeviceTrust(current, { bindingId: "binding_a", revision: "5" }), false);
  assert.equal(applyDeviceTrustSnapshot(current, { ...current, revision: 3 }), current);
});

test("the approval center and trusted-device settings share one device-trust store", () => {
  const workbench = read("ControlPlaneWorkbench.vue");
  const inbox = read("action-inbox/ActionInbox.vue");
  const settings = read("settings/TrustedDevicesSettingsSection.vue");
  const sections = read("settings/settingsSections.ts");
  const navigation = fs.readFileSync(new URL("../../i18n/locales/en-US/navigation.ts", root), "utf8");

  assert.match(workbench, /:busy-key="aiApprovalBusyKey \|\| operationApprovalBusyKey \|\| storyDecisionBusyKey \|\| deviceTrustBusyKey \|\| nodeControlPlaneTrustBusyKey"/);
  assert.match(workbench, /@decide-device="decideActionInboxDeviceTrust"/);
  assert.match(workbench, /expectedFingerprint: item\.request\.fingerprint/);
  assert.match(workbench, /expectedRevision: item\.request\.revision/);
  assert.match(workbench, /deviceTrustStore\.snapshot\.value/);
  assert.match(inbox, /v-else-if="item\.type === 'device-trust'"/);
  assert.doesNotMatch(inbox, /<Select /);
  assert.match(inbox, /navigation\.deviceTrust\.requestedAt/);
  assert.match(inbox, /navigation\.deviceTrust\.reported/);
  assert.match(inbox, /navigation\.deviceTrust\.sources\.\$\{item\.request\.source\}/);
  assert.match(inbox, /deviceRoleName\(item\)/);
  assert.match(inbox, /deviceRoleAvailable\(item\)/);
  assert.match(inbox, /navigation\.trustApproval\.role/);
  assert.match(inbox, /\.action-inbox-kind \{[^}]*font-size: 12px/);
  assert.match(inbox, /\.action-inbox-context \{ font-size: 12px/);
  assert.match(settings, /useDeviceTrustStore\(\)/);
  assert.match(settings, /expectedRevision: device\.revision/);
  assert.match(settings, /filter\(\(device\) => device\.status === "active"\)/);
  assert.match(settings, /count: devices\.length/);
  assert.match(settings, /settings\.deviceTrust\.showDetails/);
  assert.doesNotMatch(settings, /font-size:(?:[0-9]|1[01])px/);
  const cloud = read("settings/CloudConnectivitySettingsSection.vue");
  assert.doesNotMatch(sections, /id: "trusted-devices"/);
  assert.match(cloud, /TrustedDevicesSettingsSection/);
  assert.match(cloud, /settings\.cloud\.tabs\.trustedDevices/);
  assert.match(navigation, /deviceTrust: \{/);
});

test("device trust is a persistent pin flow rather than an operation approval", () => {
  const workbench = read("ControlPlaneWorkbench.vue");
  const store = read("action-inbox/useDeviceTrustStore.ts");
  const server = read("../../../../control-plane/src/control-plane/device-trust/service.ts");

  const storeFactory = read("action-inbox/deviceTrustStore.ts");
  assert.match(store, /createDeviceTrustStore\(sharedControlPlaneClient\.deviceTrust\)/);
  assert.match(storeFactory, /client\.snapshot\(\)/);
  assert.match(storeFactory, /client\.decide/);
  assert.match(storeFactory, /client\.revoke/);
  assert.doesNotMatch(store, /operationApproval/);
  assert.match(server, /CLOUD_DEVICE_TRUST_REQUEST_TTL_MS = 24 \* 60 \* 60_000/);
  assert.match(server, /async snapshot\([^)]*\): Promise<CloudDeviceTrustSnapshot> \{[\s\S]*?await this\.expire\(bindingId\)/);
  assert.match(workbench, /deviceTrustStore\.reset\(\)/);
});

test("resetting the device trust store cannot let an old recovery clear a newer one", async () => {
  const pendingSnapshots = [];
  const client = {
    snapshot: () => new Promise((resolve) => { pendingSnapshots.push(resolve); }),
    decide: async () => { throw new Error("unused"); },
    revoke: async () => { throw new Error("unused"); },
  };
  const store = createDeviceTrustStore(client);
  const first = store.recover();
  store.reset();
  const second = store.recover();

  pendingSnapshots.shift()({ revision: 1, requests: [], trustedDevices: [], roles: [] });
  await first;
  assert.equal(store.loading.value, true);
  assert.equal(store.snapshot.value.revision, -1);

  pendingSnapshots.shift()({ revision: 2, requests: [], trustedDevices: [], roles: [] });
  await second;
  assert.equal(store.loading.value, false);
  assert.equal(store.snapshot.value.revision, 2);
});
