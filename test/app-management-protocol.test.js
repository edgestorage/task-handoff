const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AppManagementEventSchema,
  AppManagementJobResponseSchema,
  AppManagementOperationRequestSchema,
  AppManagementSnapshotSchema,
  AppManagementUpdateCheckResponseSchema,
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
  apps: [{ id: "chromium", name: "Browser", kind: "gui", state: "not-installed", managementSource: "none", canInstall: true, canUninstall: false }],
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

test("app management accepts update operations and optional update capabilities", () => {
  assert.equal(AppManagementJobResponseSchema.safeParse({ job: { ...job, operation: "update" } }).success, true);
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], canUpdate: true }],
  }).success, true);
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], canUpdate: false, updateReason: { code: "BUNDLED", message: "Bundled apps cannot be updated." } }],
  }).success, true);
  // Older instances omit the optional fields entirely and must still parse.
  assert.equal(AppManagementSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], updateReason: { code: "NOT_A_REASON", message: "bad" } }],
  }).success, false);
});

test("app management accepts omitted and populated update checks", () => {
  const check = { status: "update-available", installedVersion: "1.0.0", latestVersion: "1.1.0", checkedAt: now };
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], canUpdate: true, updateCheck: check }],
  }).success, true);
  assert.equal(AppManagementSnapshotSchema.safeParse({
    ...snapshot,
    apps: [{ ...snapshot.apps[0], canUpdate: true, updateCheck: { status: "up-to-date", checkedAt: now } }],
  }).success, true);
  assert.equal(AppManagementUpdateCheckResponseSchema.safeParse({ check: { appId: "chromium", ...check } }).success, true);

  for (const candidate of [
    { status: "stale", checkedAt: now },
    { status: "update-available" },
    { status: "unknown", checkedAt: now, extra: true },
    { status: "unsupported", checkedAt: now, reason: "x".repeat(501) },
  ]) {
    assert.equal(AppManagementSnapshotSchema.safeParse({
      ...snapshot,
      apps: [{ ...snapshot.apps[0], canUpdate: true, updateCheck: candidate }],
    }).success, false, `snapshot must reject ${JSON.stringify(candidate)}`);
  }
  assert.equal(AppManagementUpdateCheckResponseSchema.safeParse({ check: { status: "up-to-date", checkedAt: now } }).success, false);
  assert.equal(AppManagementUpdateCheckResponseSchema.safeParse({ check: { appId: "chromium", status: "up-to-date", checkedAt: now }, extra: true }).success, false);
});
