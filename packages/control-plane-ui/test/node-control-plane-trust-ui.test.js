import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  mergeActionInboxItems,
  nodeControlPlaneTrustInboxItems,
  nodeControlPlaneTrustProjection,
} from "../src/apps/control-plane/action-inbox/items.ts";
import { cloudNodeTrustForNode, cloudNodeTrustPhase } from "../src/apps/control-plane/settings/cloudNodeTrust.ts";
import {
  beginCloudNodeOnboarding,
  expireCloudNodeReapplyWait,
  reapplyCloudNodeOnboarding,
  resetCloudNodeOnboarding,
  resumeCloudNodeOnboarding,
  setCloudNodeOnboardingNodeHandle,
  setCloudNodeOnboardingToken,
  syncCloudNodeOnboarding,
  useCloudNodeOnboardingAttempt,
} from "../src/apps/control-plane/settings/cloudNodeOnboardingAttempt.ts";

const root = new URL("../src/apps/control-plane/", import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, root), "utf8");

function trust(overrides = {}) {
  return {
    nodeHandle: "node_handle_a",
    nodeId: "node_a",
    displayName: "Build host",
    state: "pending",
    reason: "first-seen",
    controlPlaneId: "cp_a",
    controlPlaneFingerprint: `sha256:${"A".repeat(43)}`,
    comparisonCode: "AAAA-BBBB-CCCC-DDDD",
    requestId: "cptreq_a",
    requestedAt: "2026-10-26T08:00:00.000Z",
    expiresAt: "2026-10-27T08:00:00.000Z",
    observedAt: "2026-10-26T08:00:01.000Z",
    ...overrides,
  };
}

function snapshot(nodeTrust, overrides = {}) {
  return {
    signedIn: true,
    items: [],
    nodeRelay: {
      channels: [],
      claims: [],
      errors: [],
      onboarding: [],
      trust: nodeTrust,
      ...overrides,
    },
  };
}

test("online node Control Plane trust projects only pending outcomes into the shared inbox", () => {
  const pending = trust();
  const items = nodeControlPlaneTrustInboxItems([
    pending,
    trust({ nodeId: "node_b", state: "rejected" }),
    trust({ nodeId: "node_c", requestId: undefined }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].trust.requestId, "cptreq_a");
  assert.equal(items[0].nodeId, "node_a");
  const merged = mergeActionInboxItems([], [], [], undefined, [pending]);
  assert.equal(merged.some((item) => item.type === "node-control-plane-trust"), true);
});

test("managed node trust snapshots are the approval inbox source", () => {
  const request = {
    requestId: "cptreq_managed",
    status: "pending",
    reason: "first-seen",
    controlPlaneId: "cp_managed",
    fingerprint: `sha256:${"M".repeat(43)}`,
    comparisonCode: "MMMM-NNNN-PPPP-QQQQ",
    nodeHandle: "node_handle_a",
    requestedAt: "2026-10-26T08:00:00.000Z",
    lastSeenAt: "2026-10-26T08:00:03.000Z",
    expiresAt: "2026-10-27T08:00:00.000Z",
  };
  const projected = nodeControlPlaneTrustProjection({ id: "node_a", name: "Build host" }, request);
  assert.equal(projected.nodeId, "node_a");
  assert.equal(projected.displayName, "Build host");
  assert.equal(projected.controlPlaneFingerprint, request.fingerprint);
  assert.equal(projected.observedAt, request.lastSeenAt);

  assert.equal(projected.requestId, request.requestId);
  assert.equal(nodeControlPlaneTrustInboxItems([projected]).length, 1);

  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(workbench, /useNodeControlPlaneTrustInbox\(/);
  assert.match(workbench, /deviceTrustStore\.snapshot\.value,\s*managedNodeControlPlaneTrust\.trust\.value,/);
  assert.doesNotMatch(workbench, /nodeControlPlaneTrust\.data\.value\?\.nodeRelay\.trust/);
});

test("onboarding attempt waits for node trust, recovers after approval and remains terminal after rejection", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("new", "Build host");
  setCloudNodeOnboardingToken({
    tokenId: "token_a",
    expiresAt: "2026-10-27T08:00:00.000Z",
    command: "bind",
    installCommand: "install",
  });
  syncCloudNodeOnboarding(snapshot([], { onboarding: [{ nodeHandle: "node_handle_a", tokenId: "token_a", at: "2026-10-26T08:00:00.000Z" }] }));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.nodeHandle, "node_handle_a");

  syncCloudNodeOnboarding(snapshot([trust()]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.comparisonCode, "AAAA-BBBB-CCCC-DDDD");

  syncCloudNodeOnboarding(snapshot([]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "approved-connecting");

  syncCloudNodeOnboarding(snapshot([], { channels: [{ nodeHandle: "node_handle_a", nodeId: "node_a", allocationId: "allocation_a", connectedAt: "2026-10-26T08:01:00.000Z", connected: true }] }));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "complete");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.nodeId, "node_a");

  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");
  syncCloudNodeOnboarding(snapshot([], { channels: [{ nodeHandle: "node_handle_a", nodeId: "node_a", allocationId: "allocation_a", connectedAt: "2026-10-26T08:02:00.000Z", connected: true }] }));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");
  resetCloudNodeOnboarding();
});

test("an explicitly retried rejected attempt can resume and observe a new pending request", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");

  resumeCloudNodeOnboarding();
  syncCloudNodeOnboarding(snapshot([trust({ requestId: "cptreq_retried" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_retried");
  resetCloudNodeOnboarding();
});

test("a resumed attempt selects the newest trust request instead of an old rejected outcome", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");

  resumeCloudNodeOnboarding();
  syncCloudNodeOnboarding(snapshot([
    trust({ state: "rejected", reason: "rejected", requestedAt: "2026-10-26T08:00:00.000Z" }),
    trust({ requestId: "cptreq_new", requestedAt: "2026-10-26T09:00:00.000Z" }),
  ]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_new");
  resetCloudNodeOnboarding();
});

test("an explicit reapply ignores only the replaced request ID", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");

  reapplyCloudNodeOnboarding();
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "submitting");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "submitting");

  // The new request must be recognized even if the server clock is behind the
  // browser that initiated the reapply.
  syncCloudNodeOnboarding(snapshot([trust({ requestId: "cptreq_reapplied", requestedAt: "2026-10-31T08:00:00.000Z", observedAt: "2020-01-01T00:00:00.000Z" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_reapplied");
  resetCloudNodeOnboarding();
});

test("an unconfirmed reapply leaves submitting after a bounded wait and stays retryable", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  reapplyCloudNodeOnboarding(1_000, 30_000);
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "submitting");

  assert.equal(expireCloudNodeReapplyWait(30_999, "No response"), false);
  assert.equal(expireCloudNodeReapplyWait(31_000, "No response"), true);
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "rejected");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.error, "No response");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.reapplyDeadlineAt, undefined);
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.ignoredTrustRequestId, "cptreq_a");

  // A second attempt must keep ignoring the same old terminal outcome until a
  // newly generated request ID appears.
  reapplyCloudNodeOnboarding(31_000, 30_000);
  syncCloudNodeOnboarding(snapshot([trust({ state: "rejected", reason: "rejected" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "submitting");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.ignoredTrustRequestId, "cptreq_a");
  resetCloudNodeOnboarding();
});

test("transport diagnostics do not replace a signed pending approval outcome", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust({ observedAt: "2026-10-26T08:00:01.000Z" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");

  syncCloudNodeOnboarding(snapshot([trust({ observedAt: "2026-10-26T08:00:01.000Z" })], {
    errors: [{ nodeHandle: "node_handle_a", code: "NODE_RELAY_TRUST_TIMEOUT", message: "Node Agent did not answer the trust probe.", at: "2026-10-26T08:00:22.000Z" }],
  }));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_a");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.error, "Node Agent did not answer the trust probe.");

  syncCloudNodeOnboarding(snapshot([trust({ observedAt: "2026-10-26T08:00:23.000Z", requestId: "cptreq_fresh" })]));
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_fresh");
  resetCloudNodeOnboarding();
});

test("dialog close and back only hide the view while explicit cancel owns token cancellation", () => {
  const dialog = read("settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /function goBack\(\) \{\s*step\.value = "source";\s*\}/);
  assert.match(dialog, /function closeDialog\(\) \{\s*stopClock\(\);/);
  assert.doesNotMatch(dialog, /function closeDialog\(\) \{[\s\S]*?cancelCloudNodeBindingToken/);
  assert.match(dialog, /async function cancelBindingToken\(\) \{[\s\S]*?cancelCloudNodeBindingToken/);
  assert.match(dialog, /onboarding\.active\.value/);
});

test("node trust UI exposes approval, reapply and connection retry entry points without the device trust API", () => {
  const status = read("settings/CloudNodeTrustStatus.vue");
  const dialog = read("settings/CloudNodeOnboardingDialog.vue");
  const detail = read("settings/CloudNodeTrustDetailPanel.vue");
  const inbox = read("action-inbox/ActionInbox.vue");
  assert.match(status, /task-handoff-node-agent trust approve/);
  assert.match(status, /settings\.nodeRelay\.nodeTrust\.connectedDescription/);
  assert.match(status, /font-size: 12px/);
  assert.match(dialog, /CloudNodeTrustStatus/);
  assert.match(inbox, /decide-node-control-plane/);
  assert.doesNotMatch(dialog, /api\/device-trust|deviceTrustStore/);
  assert.match(status, /v-if="retryable"/);
  assert.match(status, /const canReapply = computed\(\(\) => props\.phase === "rejected" \|\| props\.phase === "expired"\)/);
  assert.match(status, /@click="emit\('reapply'\)"/);
  assert.match(dialog, /async function reapplyOnboarding\(\)[\s\S]*?reapplyCloudAccountNodeClaim/);
  assert.match(dialog, /expireCloudNodeReapplyWait\(now, t\("settings\.nodeRelay\.nodeTrust\.reapplyNoResponse"\)\)/);
  assert.match(dialog, /@reapply="reapplyOnboarding"/);
  assert.match(detail, /async function reapply\(\)[\s\S]*?reapplyCloudAccountNodeClaim/);
  assert.match(dialog, /refetchIntervalMs: \(\) => onboarding\.active\.value \? 2_000 : false/);
});

test("settings registry shows incomplete trust enrollments separately from managed nodes", () => {
  const modal = read("settings/SettingsModal.vue");
  const detail = read("settings/CloudNodeTrustDetailPanel.vue");
  const entry = read("settings/CloudNodeTrustEntry.vue");
  const dialog = read("settings/CloudNodeOnboardingDialog.vue");

  assert.match(modal, /pendingCloudNodeEnrollments = computed\(\(\) => \[\.\.\.\(cloudNodeRelay\.data\.value\?\.trust \?\? \[\]\)\]/);
  assert.match(modal, /class="node-list-section node-list-incomplete"[\s\S]*v-for="trust in pendingCloudNodeEnrollments"[\s\S]*CloudNodeTrustEntry/);
  assert.match(modal, /v-for="target in orderedNodes"[\s\S]*nodeStatusLabel\(target\.id\)/);
  assert.doesNotMatch(modal, /cloudNodeTrustForNode|selectedNodeTrust|nodeTrust\(/);

  assert.match(detail, /defineProps<\{ trust: CloudNodeRelayTrust; displayName\?: string; error\?: string \}>/);
  assert.doesNotMatch(detail, /import type \{ CloudNodeRelayTrust, Node \}/);
  assert.match(entry, /emit\('select', trust\.nodeHandle\)/);
  assert.match(dialog, /"show-trust": \[nodeHandle: string\]/);
});

test("node trust status has localized copy for every visible phase description", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const messages = fs.readFileSync(new URL(`../../i18n/locales/${locale}/settings.ts`, root), "utf8");
    assert.match(messages, /"approved-connectingDescription":/);
  }
});


test("registry trust follows node identity and signed outcomes, then yields to a connected channel", () => {
  const node = { id: "node_a", connectionPath: { kind: "cloud-relay", nodeHandle: "node_handle_a" }, labels: {} };
  const pending = trust();
  const relay = snapshot([pending]).nodeRelay;
  assert.equal(cloudNodeTrustForNode(node, relay), pending);
  assert.equal(cloudNodeTrustPhase(pending), "waiting-node-trust");
  assert.equal(cloudNodeTrustPhase(trust({ state: "rejected" })), "rejected");
  assert.equal(cloudNodeTrustForNode({ ...node, id: "another_node" }, relay), undefined);
  assert.equal(cloudNodeTrustForNode({ ...node, connectionEnabled: false }, relay), undefined);
  assert.equal(cloudNodeTrustForNode({ ...node, connectionPath: { kind: "direct" } }, relay), undefined);
  assert.equal(cloudNodeTrustForNode(node, { ...relay, channels: [{ nodeHandle: "node_handle_a", nodeId: "node_a", connected: true }] }), undefined);
  assert.equal(cloudNodeTrustForNode(node, { ...relay, trust: [] }), undefined);
});

test("a failed snapshot refresh keeps the approval request and its verification details", () => {
  resetCloudNodeOnboarding();
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle("node_handle_a");
  syncCloudNodeOnboarding(snapshot([trust()]));
  syncCloudNodeOnboarding(undefined, "Temporarily offline");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.phase, "waiting-node-trust");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.trust?.requestId, "cptreq_a");
  assert.equal(useCloudNodeOnboardingAttempt().attempt.value?.error, "Temporarily offline");
  resetCloudNodeOnboarding();
});
