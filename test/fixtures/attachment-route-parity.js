const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("../workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
  }).outputText, filename);
};

async function withAttachmentApp(run, optionsForRoot = () => ({})) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-route-parity-"));
  const patch = {
    TASK_HANDOFF_CONFIG: path.join(root, "config.json"),
    TASK_HANDOFF_DATA_DIR: root,
    TASK_HANDOFF_APP_CATALOG_DIR: path.join(root, "catalog"),
    TASK_HANDOFF_APP_SESSION_DIR: path.join(root, "sessions"),
    TASK_HANDOFF_RUNTIME_DIR: path.join(root, "runtime"),
    TASK_HANDOFF_EVENTS_DIR: path.join(root, "events"),
    TASK_HANDOFF_ARTIFACT_DIR: path.join(root, "artifacts"),
    TASK_HANDOFF_LOG_DIR: path.join(root, "logs"),
    TASK_HANDOFF_WEB_TOKEN_FILE: path.join(root, "web-token"),
    TASK_HANDOFF_MANAGED_APP_ROOT: path.join(root, "managed-apps"),
    TASK_HANDOFF_NOVNC_ROOT: path.join(root, "missing-novnc"),
    CODEX_HOME: path.join(root, "codex"), CLAUDE_HOME: path.join(root, "claude"),
    XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    TASK_HANDOFF_AI_PROCESS_SCAN: "0", TASK_HANDOFF_AI_SESSION_SCAN: "0", TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_CONTROL_MODE: "standalone", TASK_HANDOFF_WEB_AUTH: "off", TASK_HANDOFF_ENABLE_CC_SWITCH: "0",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: undefined, TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON: undefined,
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: undefined, TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: undefined,
    TASK_HANDOFF_NODE_AGENT_URL: undefined, TASK_HANDOFF_NODE_ID: undefined, TASK_HANDOFF_PROJECT_ID: undefined,
    TASK_HANDOFF_REGISTRATION_TOKEN: undefined, TASK_HANDOFF_INSTANCE_ID: undefined, TASK_HANDOFF_CLI_PATH: undefined,
    TASK_HANDOFF_DIAGNOSTIC_LOGS: undefined,
  };
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let app;
  try {
    const { createWebApp } = require("../../packages/controlled-instance/src/web/server.ts");
    app = await createWebApp({ staticDir: path.join(root, "missing-ui"), logger: false, ...optionsForRoot(root) });
    return await run(app, root);
  } finally {
    try { await app?.close(); } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function normalizeAttachmentResponse(response, fixture, dataDir) {
  const body = response.json();
  if (body.data?.expiresAt) {
    assert.ok(Number.isFinite(Date.parse(body.data.expiresAt)));
    body.data.expiresAt = "<expiresAt>";
    if (fixture.generatedId) {
      assert.match(body.data.id, /^att_[a-f0-9]{24}$/);
      body.data.id = "<draft-id>";
    }
  }
  const result = { status: response.statusCode, body };
  if (fixture.checkContent) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, "ai-session-attachments/drafts", `${body.data.id}.json`), "utf8"));
    result.contentHex = fs.readFileSync(path.join(dataDir, "ai-session-attachments/blobs", manifest.blobHash)).toString("hex");
  }
  return result;
}

function attachmentRequest(fixture) {
  const payload = fixture.hex ? Buffer.from(fixture.hex, "hex") : (fixture.unit || "").repeat(fixture.repeat ?? 1);
  const headers = { "content-length": Buffer.byteLength(payload) };
  if (fixture.type !== null) headers["content-type"] = fixture.type || "application/octet-stream";
  return { method: fixture.method, url: fixture.url, headers, payload };
}

module.exports = { withAttachmentApp, normalizeAttachmentResponse, attachmentRequest };
