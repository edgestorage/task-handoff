import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";
import { runtimeVersionStatusKeys, updateJobStatusKeys } from "../src/i18n/status.ts";

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
  assert.match(settings, /converging-instances/);
  assert.match(settings, /setTimeout\(\(\) => void loadManagedUpdateJobs\(nodeId, true\), 2_000\)/);
  assert.match(settings, /onScopeDispose/);
});

test("instance update controls are replaced by authoritative convergence state", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const instanceGroup = panel.match(/<section class="managed-update-group instance-update-group">[\s\S]*?<\/section>/)?.[0] || "";

  assert.match(instanceGroup, /instance\.runtimeVersion/);
  assert.match(instanceGroup, /runtimeVersionSummary\(instance\)/);
  assert.doesNotMatch(instanceGroup, /checkManagedUpdate|applyManagedUpdate|<Button/);
  assert.doesNotMatch(panel, /component: ['"]controlled-instance['"]/);
});

test("node rollout presents converging, successful, and degraded authoritative phases", () => {
  const t = createControlPlaneI18nForTest("en-US").global.t;

  assert.equal(t(updateJobStatusKeys["converging-instances"]), "Converging instances");
  assert.equal(t(updateJobStatusKeys.succeeded), "Succeeded");
  assert.equal(t(updateJobStatusKeys.degraded), "Degraded");
  assert.equal(t(runtimeVersionStatusKeys.matched), "Matched");
  assert.equal(t(runtimeVersionStatusKeys.failed), "Failed");
});

test("node rollout confirmation discloses every restart impact before apply", () => {
  const t = createControlPlaneI18nForTest("en-US").global.t;
  const message = t("settings.nodeDetail.updateConfirm", {
    current: "0.0.8",
    available: "0.0.9",
    restarting: 3,
    active: 1,
    stopped: 2,
  });

  assert.match(message, /0\.0\.8[\s\S]*0\.0\.9/);
  assert.match(message, /3 running managed instance/);
  assert.match(message, /active work[\s\S]*interrupted/);
  assert.match(message, /2 stopped instance[\s\S]*before their next start/);
  assert.match(message, /containers will not be removed or recreated/i);
});
