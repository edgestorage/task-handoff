const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const test = require("node:test");
const tar = require("tar");

const { ControlPlaneService } = require("../packages/control-plane/src/control-plane/application/service.ts");
const { ControlPlaneSettingsSchema, sanitizeStoredControlPlaneSettings } = require("../packages/control-plane/src/control-plane/catalog/inputs.ts");
const { createControlPlaneDiagnosticLogger, createDiagnosticLogsArchive } = require("../packages/control-plane/src/control-plane/diagnostics/logs.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const { createControlPlaneApp, routeAuthorization } = require("../packages/control-plane/src/control-plane/http/server.ts");

test("diagnostic log setting migrates from the environment and persists manual changes", () => {
  const previous = process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-setting-"));
  process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS = "1";
  try {
    const service = new ControlPlaneService(controlPlaneStorePaths(dataDir));
    service.init();
    assert.equal(service.getSettings().diagnosticLogs, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "control-plane-settings.json"), "utf8")).diagnosticLogs, true);
    assert.equal(service.updateSettings({ diagnosticLogs: false }).diagnosticLogs, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "control-plane-settings.json"), "utf8")).diagnosticLogs, false);
  } finally {
    if (previous === undefined) delete process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS;
    else process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS = previous;
  }
});

test("stored diagnostic log setting gets an explicit normalized default", () => {
  assert.equal(ControlPlaneSettingsSchema.parse({}).diagnosticLogs, false);
  assert.equal(sanitizeStoredControlPlaneSettings({}, { diagnosticLogs: true }).diagnosticLogs, true);
});

test("diagnostic export requires settings-management authority", () => {
  assert.deepEqual(routeAuthorization("GET", "/api/control-plane/diagnostic-logs/export"), {
    action: "manage-settings",
    resource: { type: "control-plane-settings" },
  });
});

test("diagnostic logger responds to runtime changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-writer-"));
  let enabled = false;
  const forwarded = [];
  const logger = createControlPlaneDiagnosticLogger(root, () => enabled, {
    info: (data, message) => forwarded.push({ data, message }),
  });
  logger.info({ ignored: true }, "disabled");
  assert.equal(fs.existsSync(path.join(root, "control-plane.log")), false);
  enabled = true;
  logger.info({ requestId: "request_1" }, "enabled");
  assert.equal(forwarded.length, 1);
  assert.match(fs.readFileSync(path.join(root, "control-plane.log"), "utf8"), /request_1/);
});

test("diagnostic logger rotates bounded generations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-rotation-"));
  const logger = createControlPlaneDiagnosticLogger(root, () => true, {}, { maxBytes: 160, backupCount: 2 });

  for (let index = 0; index < 12; index += 1) logger.info({ index, payload: "x".repeat(48) }, `entry-${index}`);

  for (const name of ["control-plane.log", "control-plane.1.log", "control-plane.2.log"]) {
    const filePath = path.join(root, name);
    assert.equal(fs.existsSync(filePath), true);
    assert.ok(fs.statSync(filePath).size <= 160);
  }
});

test("diagnostic logger bounds an oversized preexisting generation during rotation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-existing-"));
  fs.writeFileSync(path.join(root, "control-plane.log"), Buffer.alloc(512, "o"));
  const logger = createControlPlaneDiagnosticLogger(root, () => true, {}, { maxBytes: 160, backupCount: 2 });

  logger.info({ recent: true }, "recent");

  assert.ok(fs.statSync(path.join(root, "control-plane.log")).size <= 160);
  assert.equal(fs.statSync(path.join(root, "control-plane.1.log")).size, 160);
});

test("diagnostic export contains only allowlisted log trees", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-export-"));
  const nodeAgentDataDir = path.join(dataDir, "node-agent");
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "log"), { recursive: true });
  fs.mkdirSync(path.join(nodeAgentDataDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(nodeAgentDataDir, "local-instances", "instance_1", "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", "control-plane.log"), "control-plane\n");
  fs.writeFileSync(path.join(dataDir, "log", "desktop.log"), "desktop\n");
  fs.writeFileSync(path.join(nodeAgentDataDir, "logs", "node-agent.out.log"), "node-agent\n");
  fs.writeFileSync(path.join(nodeAgentDataDir, "local-instances", "instance_1", "logs", "controlled-instance.log"), "instance\n");
  fs.writeFileSync(path.join(nodeAgentDataDir, "local-instances", "instance_1", "runtime.jsonl"), "must-not-export\n");
  fs.writeFileSync(path.join(nodeAgentDataDir, "identity.jsonl"), "must-not-export\n");

  const archive = await createDiagnosticLogsArchive({ dataDir, nodeAgentDataDir, diagnosticLogsEnabled: true });
  const archivePath = path.join(dataDir, "diagnostics.tar.gz");
  await pipeline(archive.stream, fs.createWriteStream(archivePath));
  const extracted = path.join(dataDir, "extracted");
  fs.mkdirSync(extracted);
  await tar.extract({ cwd: extracted, file: archivePath });

  assert.equal(fs.readFileSync(path.join(extracted, "logs", "control-plane", "control-plane.log"), "utf8"), "control-plane\n");
  assert.equal(fs.readFileSync(path.join(extracted, "logs", "desktop", "desktop.log"), "utf8"), "desktop\n");
  assert.equal(fs.readFileSync(path.join(extracted, "logs", "node-agent", "node-agent.out.log"), "utf8"), "node-agent\n");
  assert.equal(fs.readFileSync(path.join(extracted, "logs", "local-instances", "instance_1", "controlled-instance.log"), "utf8"), "instance\n");
  assert.equal(fs.existsSync(path.join(extracted, "logs", "node-agent", "identity.jsonl")), false);
  assert.equal(fs.existsSync(path.join(extracted, "logs", "local-instances", "instance_1", "runtime.jsonl")), false);
});

test("diagnostic export keeps only the latest 1 MiB of an oversized log", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-tail-"));
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const oldData = Buffer.alloc(512 * 1024, "o");
  const recentData = Buffer.alloc(1024 * 1024, "r");
  fs.writeFileSync(path.join(logsDir, "control-plane.log"), Buffer.concat([oldData, recentData]));

  const archive = await createDiagnosticLogsArchive({ dataDir, diagnosticLogsEnabled: true });
  const archivePath = path.join(dataDir, "diagnostics.tar.gz");
  await pipeline(archive.stream, fs.createWriteStream(archivePath));
  const extracted = path.join(dataDir, "extracted");
  fs.mkdirSync(extracted);
  await tar.extract({ cwd: extracted, file: archivePath });

  const exported = fs.readFileSync(path.join(extracted, "logs", "control-plane", "control-plane.log"));
  assert.equal(exported.length, 1024 * 1024);
  assert.deepEqual(exported, recentData);
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"));
  assert.equal(manifest.limits.perFileBytes, 1024 * 1024);
  assert.equal(manifest.files[0].truncated, true);
});

test("control plane settings API toggles diagnostics and downloads an archive", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-api-"));
  const app = await createControlPlaneApp({ dataDir, logger: false });
  try {
    const updated = await app.inject({ method: "PATCH", url: "/api/control-plane/settings", payload: { diagnosticLogs: true } });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.payload).data.diagnosticLogs, true);
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    fs.appendFileSync(path.join(dataDir, "logs", "control-plane.log"), "api-log\n");

    const response = await app.inject({ method: "GET", url: "/api/control-plane/diagnostic-logs/export" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/gzip");
    assert.match(response.headers["content-disposition"], /^attachment; filename="task-handoff-diagnostic-logs-/);
    const archivePath = path.join(dataDir, "api-diagnostics.tar.gz");
    fs.writeFileSync(archivePath, response.rawPayload);
    const extracted = path.join(dataDir, "api-extracted");
    fs.mkdirSync(extracted);
    await tar.extract({ cwd: extracted, file: archivePath });
    assert.match(fs.readFileSync(path.join(extracted, "logs", "control-plane", "control-plane.log"), "utf8"), /api-log/);
  } finally {
    await app.close();
  }
});
