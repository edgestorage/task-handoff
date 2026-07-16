const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AppManagementEventSchema,
  AppManagementJobResponseSchema,
  AppManagementOperationRequestSchema,
  AppManagementSnapshotSchema,
} = require("../packages/protocol/src/control-plane.ts");

const now = "2026-07-16T00:00:00.000Z";
const job = {
  id: "job_1",
  appId: "chromium",
  operation: "install",
  state: "queued",
  requestedAt: now,
  updatedAt: now,
};
const snapshot = {
  streamId: "appstream_1",
  sequence: 1,
  capabilities: { platform: "linux", arch: "x64", installers: ["apt"], privilege: "passwordless-sudo" },
  apps: [{ id: "chromium", name: "Browser", kind: "gui", state: "not-installed", canInstall: true, canUninstall: false }],
  activeJobs: [job],
  recentJobs: [],
  observedAt: now,
};

test("app management schemas accept authoritative snapshots, jobs, and events", () => {
  assert.deepEqual(AppManagementSnapshotSchema.parse(snapshot), snapshot);
  assert.deepEqual(AppManagementJobResponseSchema.parse({ job }), { job });
  assert.deepEqual(AppManagementEventSchema.parse({ type: "app-management", streamId: "appstream_1", sequence: 1, observedAt: now, job }), {
    type: "app-management", streamId: "appstream_1", sequence: 1, observedAt: now, job,
  });
});

test("app management operation input rejects arbitrary install content", () => {
  assert.deepEqual(AppManagementOperationRequestSchema.parse({ requestId: "request_1" }), { requestId: "request_1" });
  for (const input of [
    { url: "https://example.invalid/app.tgz" },
    { package: "chromium" },
    { script: "install.sh" },
    { command: "apt install chromium" },
    { requestId: "request_1", future: true },
  ]) {
    assert.equal(AppManagementOperationRequestSchema.safeParse(input).success, false);
  }
});

test("app management public projections reject recipes and secrets", () => {
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], command: "apt", packages: ["chromium"], key: "secret" }],
  }).success, false);
  assert.equal(AppManagementEventSchema.safeParse({ type: "app-management", streamId: "appstream_1", sequence: 2, observedAt: now }).success, false);
});
