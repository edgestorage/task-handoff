import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";
import { runtimeVersionStatusKeys, updateJobStatusKeys } from "../src/i18n/status.ts";
import { findTrackedTerminalNodeUpdate, refreshNodeUpdateHttpState } from "../src/apps/control-plane/settings/nodeUpdatePolling.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("node update clients expose one rollout without an instance target", () => {
  const types = read("src/api/types.ts");
  const queries = read("src/api/queries.ts");
  const settings = read("src/apps/control-plane/settings/useNodeSettings.ts");

  assert.doesNotMatch(types, /type UpdateTarget/);
  assert.match(queries, /checkNodeUpdate\(nodeId: string, channel: UpdateChannel\)[\s\S]*\{ channel \}/);
  assert.match(queries, /applyNodeUpdate\(nodeId: string, input: ApplyUpdateRequest\)[\s\S]*postApiData<UpdateJob>[\s\S]*input/);
  assert.match(settings, /targetVersion: check\.availableVersion/);
  assert.match(settings, /preflightToken: check\.preflightToken/);
  assert.doesNotMatch(settings, /instanceId|controlled-instance/);
});

test("active Node rollouts refresh authoritative jobs only while non-terminal", () => {
  const settings = read("src/apps/control-plane/settings/useNodeSettings.ts");
  assert.match(settings, /isActiveNodeUpdate\(job\.status\)/);
  assert.match(settings, /const refreshNodeId = trackedUpdateJob\.value\?\.nodeId \|\| nodeId/);
  assert.match(settings, /setTimeout\(\(\) => void loadManagedUpdateJobs\(refreshNodeId, true\), 2_000\)/);
  assert.match(settings, /refreshNodeUpdateHttpState\(\{/);
  assert.match(settings, /refreshRuntimeState: refreshNodeRuntimeState/);
  assert.doesNotMatch(settings, /Promise\.all\(\[checkSettingsNode\(nodeId\), refresh/);
  assert.match(settings, /onScopeDispose/);
});

test("an active Node rollout refreshes runtime state without issuing a redundant Node check", async () => {
  const calls = [];

  await refreshNodeUpdateHttpState({
    status: "converging-instances",
    refreshRuntimeState: async () => { calls.push("runtime-state"); },
    refreshTopology: async () => { calls.push("topology"); },
  });

  assert.deepEqual(calls, ["runtime-state"]);
});

test("a queued update is correlated by job id and reports only its authoritative terminal outcome", () => {
  const jobs = [
    { id: "older", status: "succeeded" },
    { id: "current", status: "restarting-node" },
  ];

  assert.equal(findTrackedTerminalNodeUpdate("current", jobs), undefined);
  const completed = { id: "current", status: "succeeded" };
  assert.equal(findTrackedTerminalNodeUpdate("current", [jobs[0], completed]), completed);
  assert.equal(findTrackedTerminalNodeUpdate("missing", [completed]), undefined);
});

test("the tracked server update prompts for one explicit refresh after reconnect", () => {
  const settings = read("src/apps/control-plane/settings/useNodeSettings.ts");

  assert.match(settings, /const job = await applyNodeUpdate/);
  assert.match(settings, /trackedUpdateJob\.value = \{ id: job\.id, nodeId, nodeName, target \}/);
  assert.match(settings, /findTrackedTerminalNodeUpdate\(tracked\?\.id, jobs\)/);
  assert.match(settings, /trackedUpdateJob\.value = undefined/);
  assert.match(settings, /duration: Infinity/);
  assert.match(settings, /onClick: \(\) => window\.location\.reload\(\)/);
  assert.match(settings, /if \(tracked\.target === "node-agent"\)[\s\S]*?return;[\s\S]*?duration: Infinity/);
  assert.match(settings, /job\.error\?\.message/);
});

test("settings mutations use domain refresh callbacks instead of a global refresh", () => {
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  const projects = read("src/apps/control-plane/settings/useProjectSettings.ts");
  const images = read("src/apps/control-plane/settings/useImageSettings.ts");
  const models = read("src/apps/control-plane/settings/useModelSettings.ts");
  const resources = read("src/apps/control-plane/settings/useNodeResourceSettings.ts");

  assert.match(modal, /invalidateControlPlaneDomains\(queryClient, \["manual"\]\)/);
  assert.match(projects, /refreshProjects/);
  assert.match(images, /refreshImages/);
  assert.match(models, /refreshModels/);
  assert.match(resources, /refreshFolders/);
  assert.match(resources, /refreshRuntimeState/);
  assert.doesNotMatch(modal, /queryKey: \["control-plane-node-runtimes"\]/);
  assert.doesNotMatch(modal, /queryKey: \["instance-board"\]/);
});

test("instance update controls are replaced by authoritative convergence state", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const instanceGroup = panel.match(/<section class="managed-update-group instance-update-group">[\s\S]*?<\/section>/)?.[0] || "";

  assert.match(instanceGroup, /instance\.runtimeVersion/);
  assert.match(instanceGroup, /runtimeVersionSummary\(instance\)/);
  assert.match(panel, /state\.phase === "failed" && instance\.status === "running" \? "settings\.nodeDetail\.runtimeVersionFailedSummary"/);
  assert.doesNotMatch(instanceGroup, /checkManagedUpdate|applyManagedUpdate|<Button/);
  assert.doesNotMatch(panel, /component: ['"]controlled-instance['"]/);
});

test("node update impact uses the panel body typography instead of browser paragraph defaults", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");

  assert.match(panel, /class="managed-update-impact"/);
  assert.match(panel, /\.managed-update-impact\s*\{[\s\S]*?margin:\s*0;[\s\S]*?font-size:\s*var\(--node-detail-body-size\);/);
});

test("node update clients retain v0.0.32 rollout statuses while instance state remains independent", () => {
  const t = createControlPlaneI18nForTest("en-US").global.t;

  assert.equal(t(updateJobStatusKeys["converging-instances"]), "Converging instances");
  assert.equal(t(updateJobStatusKeys.succeeded), "Succeeded");
  assert.equal(t(updateJobStatusKeys.degraded), "Degraded");
  assert.equal(t(runtimeVersionStatusKeys.matched), "Matched");
  assert.equal(t(runtimeVersionStatusKeys.failed), "Update failed");
  assert.match(t("settings.nodeDetail.runtimeVersionFailedSummary", {
    actual: "0.0.8",
    desired: "0.0.9",
    attempt: 3,
  }), /Update failed · still running 0\.0\.8 → desired 0\.0\.9 · 3 attempts/);
});

test("server and remote Node Agent confirmations disclose independent update ownership", () => {
  const t = createControlPlaneI18nForTest("en-US").global.t;
  const input = {
    name: "Remote node",
    current: "0.0.8",
    available: "0.0.9",
    restarting: 3,
    active: 1,
    stopped: 2,
  };
  const serverMessage = t("settings.nodeDetail.updateServerConfirm", input);
  const nodeMessage = t("settings.nodeDetail.updateNodeAgentConfirm", input);

  for (const message of [serverMessage, nodeMessage]) {
    assert.match(message, /0\.0\.8[\s\S]*0\.0\.9/);
    assert.match(message, /does not wait for instance convergence/i);
    assert.match(message, /other nodes/i);
    assert.match(message, /3 running managed instance/);
    assert.match(message, /active work[\s\S]*interrupted/);
    assert.match(message, /2 stopped instance[\s\S]*before their next start/);
    assert.match(message, /containers will not be removed or recreated/i);
  }
  assert.match(serverMessage, /control plane and its built-in node agent/i);
  assert.match(nodeMessage, /Only this node agent will restart/i);
});
