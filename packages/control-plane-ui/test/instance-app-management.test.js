import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { useInstanceAppManagement } from "../src/apps/control-plane/instance-settings/useInstanceAppManagement.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const now = "2026-07-16T00:00:00.000Z";

function app(overrides = {}) {
  return {
    id: "chromium",
    name: "Chromium",
    kind: "gui",
    state: "not-installed",
    managementSource: "none",
    canInstall: true,
    canUninstall: false,
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: "appjob_1",
    appId: "chromium",
    operation: "install",
    state: "running",
    requestedAt: now,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function snapshot(sequence, overrides = {}) {
  return {
    streamId: "appstream_1",
    sequence,
    capabilities: { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" },
    apps: [app()],
    activeJobs: [],
    recentJobs: [],
    observedAt: now,
    ...overrides,
  };
}

test("app management recovery joins a snapshot to only newer buffered events", async () => {
  let resolveSnapshot;
  const pending = new Promise((resolve) => { resolveSnapshot = resolve; });
  const store = useInstanceAppManagement({ load: () => pending, errorText: String });

  const recovery = store.recover("instance_1");
  store.applyEvent("instance_1", { type: "app-management", streamId: "appstream_1", sequence: 4, observedAt: now, job: job() });
  resolveSnapshot(snapshot(3));
  await recovery;

  assert.equal(store.state("instance_1").snapshot.sequence, 4);
  assert.equal(store.state("instance_1").snapshot.activeJobs[0].id, "appjob_1");
  assert.equal(store.state("instance_1").snapshot.apps[0].state, "not-installed");
  assert.equal(store.state("instance_1").snapshot.apps[0].canInstall, false);

  store.applyEvent("instance_1", { type: "app-management", streamId: "appstream_1", sequence: 3, observedAt: now, job: job({ id: "stale" }) });
  assert.equal(store.state("instance_1").snapshot.activeJobs[0].id, "appjob_1");
});

test("accepted operation responses do not optimistically mark an app installed", async () => {
  const store = useInstanceAppManagement({ load: async () => snapshot(1), errorText: String });
  await store.recover("instance_1");
  store.applyJob("instance_1", job({ state: "queued", startedAt: undefined }));

  const current = store.state("instance_1").snapshot;
  assert.equal(current.apps[0].state, "not-installed");
  assert.equal(current.apps[0].activeJobId, "appjob_1");
});

test("terminal events keep authoritative detection state after a failed job", async () => {
  const store = useInstanceAppManagement({ load: async () => snapshot(1), errorText: String });
  await store.recover("instance_1");
  const failed = job({ state: "failed", error: { code: "postcondition_failed", message: "Detection did not confirm install.", retryable: true }, finishedAt: now });
  store.applyEvent("instance_1", {
    type: "app-management",
    streamId: "appstream_1",
    sequence: 2,
    observedAt: now,
    job: failed,
    snapshot: snapshot(2, { apps: [app()], recentJobs: [failed] }),
  });

  const current = store.state("instance_1").snapshot;
  assert.equal(current.apps[0].state, "not-installed");
  assert.equal(current.recentJobs[0].error.code, "postcondition_failed");
});

test("a restarted app-management stream replaces a higher-sequence stale snapshot", async () => {
  const store = useInstanceAppManagement({ load: async () => snapshot(40), errorText: String });
  await store.recover("instance_1");
  const restarted = snapshot(0, { streamId: "appstream_2", apps: [app({ state: "installed", canInstall: false, canUninstall: true })] });
  store.applyEvent("instance_1", {
    type: "app-management",
    streamId: "appstream_2",
    sequence: 0,
    observedAt: now,
    snapshot: restarted,
  });

  assert.equal(store.state("instance_1").snapshot.streamId, "appstream_2");
  assert.equal(store.state("instance_1").snapshot.sequence, 0);
  assert.equal(store.state("instance_1").snapshot.apps[0].state, "installed");

  store.applyEvent("instance_1", {
    type: "app-management",
    streamId: "appstream_1",
    sequence: 41,
    observedAt: now,
    snapshot: snapshot(41, { apps: [app()] }),
  });
  assert.equal(store.state("instance_1").snapshot.streamId, "appstream_2");
  assert.equal(store.state("instance_1").snapshot.apps[0].state, "installed");
});

test("Apps settings exposes capability states, task feedback, safe confirmation, and launcher separation", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  const queries = read("src/api/queries.ts");
  const events = read("src/apps/control-plane/useControlPlaneEvents.ts");
  const protocol = read("../protocol/src/control-plane.ts");

  assert.match(protocol, /\["installed", "not-installed", "broken", "unsupported"\]/);
  assert.match(dialog, /managedAppStateLabel\(app\.state\)/);
  for (const value of ["queued", "succeeded", "failed", "cancelled", "interrupted"])
    assert.match(dialog, new RegExp(value));
  assert.match(dialog, /insufficient|Privilege|installReason|uninstallReason/i);
  assert.match(dialog, /t\("instances\.settings\.uninstallDescription"\)/);
  assert.match(dialog, /t\("instances\.settings\.customLaunchers"\)/);
  assert.match(dialog, /t\("instances\.settings\.customLaunchersDescription"\)/);
  assert.match(dialog, /AlertDialogContent/);
  assert.match(dialog, /Progress/);
  assert.match(dialog, /t\("instances\.settings\.liveInstallerOutput"\)/);
  assert.match(dialog, /executionOutput/);
  assert.match(dialog, /t\('instances\.settings\.appFilters'\)/);
  assert.match(dialog, /filteredManagedApps/);
  assert.match(dialog, /t\('instances\.settings\.refreshApps'\)/);
  assert.match(dialog, /t\("instances\.settings\.confirmInstall"\)/);
  assert.match(dialog, /<Button type="button" :disabled="Boolean\(operationSubmitting\)" @click="confirmAppOperation">/);
  assert.doesNotMatch(dialog, /AlertDialogAction/);
  assert.match(dialog, /instance-app-confirmation-summary/);
  assert.match(protocol, /logTail/);
  assert.match(queries, /postApiData<AppManagementJobResponse>[^\n]+requestId \? \{ requestId \} : \{\}/);
  assert.doesNotMatch(queries, /packageName|downloadUrl|command|script/);
  assert.match(events, /recoverOpen/);
  assert.match(events, /event\.scope\.instanceId/);
});
