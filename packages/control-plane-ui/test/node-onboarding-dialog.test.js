import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("node onboarding is reachability-driven instead of transport tabs", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /"network" \| "target" \| "connect" \| "complete"/);
  assert.match(dialog, /probeControlPlaneOrigin/);
  assert.match(dialog, /selectReachability/);
  assert.match(dialog, /agentInstalled/);
  assert.match(dialog, /nodeAgentPublic/);
  assert.doesNotMatch(dialog, /<Tabs|<TabsTrigger/);
});

test("node onboarding reuses authoritative connection APIs and invite identity", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /createNodeJoinInvite/);
  assert.match(dialog, /nodeAgentInstallCommand/);
  assert.match(dialog, /createNode\(/);
  assert.match(dialog, /claimControlPlaneProxyNode/);
  assert.match(dialog, /event\.inviteId !== joinInvite\.value\?\.id/);
  assert.match(dialog, /controlPlaneQueryKeys\.nodes/);
  assert.match(dialog, /props\.nodes\.find/);
});

test("node onboarding polls authoritative invite status to recover a missed joined event", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /getNodeJoinInviteStatus\(inviteId, request\.signal\)/);
  assert.match(dialog, /status\.status === "completed"/);
  assert.match(dialog, /pendingNodeId\.value = status\.nodeId/);
  assert.match(dialog, /scheduleInviteStatusPoll\(joinInvite\.value\.id, 0\)/);
  assert.match(dialog, /stopInviteStatusPolling\(\)/);
});

test("an installed Node Agent can connect from the UI or the local IPC command", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /reverseConnectionMethod = ref<"ui" \| "command">\("ui"\)/);
  assert.match(dialog, /settings\.nodeOnboarding\.reverse\.useUi/);
  assert.match(dialog, /settings\.nodeOnboarding\.reverse\.useCommand/);
  assert.match(dialog, /settings\.nodeOnboarding\.reverse\.uiStepAdd/);
  assert.match(dialog, /copyReverseValue\('url'\)/);
  assert.match(dialog, /copyReverseValue\('token'\)/);
  assert.match(dialog, /copyReverseValue\('command'\)/);
  assert.match(dialog, /nodeAgentConnectCommand/);
  assert.match(dialog, /reverseConnectionMethod\.value = "ui"/);
});

test("node onboarding keeps secrets local and clears them on completion and close", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /joinInvite\.value = undefined/);
  assert.match(dialog, /directDraft\.joinToken = ""/);
  assert.match(dialog, /proxyDraft\.inviteToken = ""/);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage|URLSearchParams/);
  assert.match(dialog, /type="password"/);
});

test("node onboarding constrains the dialog and scrolls only its content", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /<ScrollArea class="node-onboarding-scroll"/);
  assert.match(dialog, /max-height: min\(760px, calc\(100dvh - 32px\)\)/);
  assert.match(dialog, /grid-template-rows: auto auto minmax\(0, 1fr\) auto/);
  assert.match(dialog, /:aria-current="item\.id === step \? 'step' : undefined"/);
  assert.match(dialog, /\.node-onboarding-progress li:not\(:last-child\)::after/);
  assert.match(dialog, /\.node-onboarding-progress li\.complete::after/);
  assert.doesNotMatch(dialog, /font-size:\s*(?:[0-9]|1[01])px/);
});

test("unsupported account relay is capability-gated instead of reusing device relay", () => {
  const dialog = read("src/apps/control-plane/settings/NodeOnboardingDialog.vue");
  assert.match(dialog, /accountUnavailable/);
  assert.match(dialog, /aria-disabled="true"/);
  assert.doesNotMatch(dialog, /official-relay|CloudRelayConnector/);
});
