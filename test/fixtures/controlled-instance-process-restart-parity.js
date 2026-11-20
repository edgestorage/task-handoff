const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SESSION_ID = "ses_restart_process";
const REGISTRATION_TOKEN = "test-registration-token";
const DYNAMIC_KEYS = new Set(["pid", "processId"]);

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !name.startsWith("TASK_HANDOFF_") && name !== "WORKSPACE"
  )));
}

function runtimeEnvironment({ dataDir, workspace, port, instanceId }) {
  return {
    ...cleanEnvironment(),
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_INSTANCE_ID: instanceId,
    TASK_HANDOFF_INSTANCE_NAME: "process-restart-parity",
    TASK_HANDOFF_REGISTRATION_TOKEN: REGISTRATION_TOKEN,
    TASK_HANDOFF_DATA_DIR: dataDir,
    TASK_HANDOFF_WORKSPACE: workspace,
    TASK_HANDOFF_WORKSPACE_ROOTS: workspace,
    TASK_HANDOFF_WEB_HOST: "127.0.0.1",
    TASK_HANDOFF_WEB_PORT: String(port),
    TASK_HANDOFF_HEARTBEAT_INTERVAL_MS: "600000",
    TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS: "600000",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_APP_SESSION_PERSIST: "1",
    NODE_NO_WARNINGS: "1",
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Unable to allocate a process restart test port");
  return port;
}

function writeMinimalUi(directory) {
  fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
  fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html><html><body>restart-parity</body></html>\n");
  fs.writeFileSync(path.join(directory, "assets", "app.js"), "globalThis.__restartParity = true;\n");
}

function startRuntime(runtime, port) {
  const child = spawn(runtime.command, [...runtime.args, "web", "--port", String(port), "--static-dir", runtime.uiDir], {
    cwd: runtime.cwd,
    env: runtimeEnvironment({
      dataDir: runtime.dataDir,
      workspace: runtime.workspace,
      port,
      instanceId: runtime.instanceId,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    logs: () => ({ stdout, stderr }),
  };
}

async function waitForHealth(base, runtime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      const logs = runtime.logs();
      throw new Error(`${runtime.command} exited before becoming healthy:\n${logs.stderr || logs.stdout}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = runtime.logs();
  throw new Error(`${runtime.command} did not become healthy: ${lastError?.message}\n${logs.stderr || logs.stdout}`);
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode !== null) return runtime.exited;
  runtime.child.kill("SIGTERM");
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), 10_000);
  });
  const result = await Promise.race([runtime.exited, timeout]);
  clearTimeout(timeoutHandle);
  if (result === "timeout" && runtime.child.exitCode === null) {
    runtime.child.kill("SIGKILL");
    return runtime.exited;
  }
  return result;
}

async function request(base, specification) {
  const method = specification.method || "GET";
  const headers = { ...(specification.headers || {}) };
  let body;
  if (specification.body !== undefined) {
    headers["content-type"] ||= "application/json";
    body = JSON.stringify(specification.body);
  }
  let response;
  try {
    response = await fetch(`${base}${specification.path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error?.cause instanceof Error ? error.cause.message : error?.cause;
    throw new Error(`Request ${method} ${base}${specification.path} failed${cause ? `: ${cause}` : ""}`, { cause: error });
  }
  const text = await response.text();
  let parsed = text;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    parsed = JSON.parse(text);
  }
  return { status: response.status, body: parsed };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeString(value, roots) {
  let normalized = value;
  for (const [name, target] of Object.entries(roots)) {
    normalized = normalized.split(target).join(`<${name}>`);
    normalized = normalized.split(target.replaceAll("\\", "/")).join(`<${name}>`);
  }
  return normalized
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>");
}

function normalize(value, roots) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key, entry]) => entry !== undefined && !DYNAMIC_KEYS.has(key)).map(([key, entry]) => [key, (
      ["bodyRevision", "detailRevision", "revision", "turnsRevision"].includes(key)
      && typeof entry === "string"
      && /^[A-Za-z0-9_-]{22}$/.test(entry)
    ) ? "<hash>" : normalize(entry, roots)]));
  }
  if (typeof value === "string") return normalizeString(value, roots);
  return value;
}

function sessionSnapshot(catalog, sessionId) {
  return catalog.body?.data?.snapshot?.sessions?.find((session) => session.id === sessionId);
}

async function observeHttpState(base, input) {
  const detail = await request(base, { path: `/api/ai-sessions/${SESSION_ID}` });
  const queue = await request(base, { path: `/api/ai-sessions/${SESSION_ID}/queue` });
  const state = await request(base, { path: "/api/ai-sessions/state" });
  const custom = await request(base, { path: "/api/apps/catalog/custom" });
  const catalog = await request(base, { path: "/api/apps/catalog" });
  return {
    detail,
    queue,
    state: sessionSnapshot(state, SESSION_ID),
    customCatalog: custom,
    catalogItem: catalog.body?.data?.find((item) => item.id === input.customCatalog.items[0].id),
  };
}

async function observeAppSessionState(base, appSessionId) {
  const detail = await request(base, { path: `/api/apps/sessions/${appSessionId}` });
  const state = await request(base, { path: "/api/apps/sessions/state" });
  return {
    detail,
    state: state.body?.data?.snapshot?.sessions?.find((session) => session.id === appSessionId),
  };
}

function seedSession(input, workspace) {
  const session = structuredClone(input.session);
  session.cwd = workspace;
  session.title = input.session.title;
  session.queue.paused = true;
  return session;
}

async function observeProcessRestart(runtime, input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `controlled-instance-${runtime.kind}-restart-`));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const uiDir = path.join(root, "ui");
  const aiSessionDir = path.join(dataDir, "ai-sessions");
  fs.mkdirSync(aiSessionDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  writeMinimalUi(uiDir);
  const sessionPath = path.join(aiSessionDir, `${SESSION_ID}.json`);
  fs.writeFileSync(sessionPath, `${JSON.stringify(seedSession(input, workspace), null, 2)}\n`);
  const roots = { root, data: dataDir, workspace };
  const instanceId = `inst_restart_${runtime.kind}`;
  let current;
  let port;

  try {
    port = await freePort();
    current = startRuntime({ ...runtime, dataDir, workspace, uiDir, instanceId }, port);
    let base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, current);

    const edit = await request(base, {
      method: "PATCH",
      path: `/api/ai-sessions/${SESSION_ID}/queue/${input.session.queue.items[0].id}`,
      body: {
        expectedRevision: input.session.queue.revision,
        message: input.editedMessage,
      },
    });
    const customCatalogWrite = await request(base, {
      method: "PATCH",
      path: "/api/apps/catalog/custom",
      body: input.customCatalog,
    });
    const persistenceSettings = await request(base, {
      method: "PUT",
      path: "/api/internal/ai-session-persistence-settings",
      headers: { authorization: `Bearer ${REGISTRATION_TOKEN}` },
      body: input.persistenceSettings,
    });
    const launchedApp = await request(base, {
      method: "POST",
      path: "/api/apps/sessions",
      body: {
        appId: input.customCatalog.items[0].id,
        title: input.appSession.title,
        args: input.appSession.args,
        cwd: workspace,
      },
    });
    const appSessionId = launchedApp.body?.data?.id;
    assert.ok(appSessionId, "app session launch must return an id");
    const renamedApp = await request(base, {
      method: "PATCH",
      path: `/api/apps/sessions/${appSessionId}`,
      body: { title: input.appSession.renamedTitle },
    });
    const before = await observeHttpState(base, input);
    const beforeApp = await observeAppSessionState(base, appSessionId);
    const beforeDisk = {
      session: readJson(sessionPath),
      customCatalog: readJson(path.join(dataDir, "app-catalog", "custom.json")),
      persistenceSettings: readJson(path.join(dataDir, "ai-session-persistence", "settings.json")),
      appSession: readJson(path.join(dataDir, "app-sessions", appSessionId, "metadata.json")),
    };

    await stopRuntime(current);
    current = undefined;
    port = await freePort();
    current = startRuntime({ ...runtime, dataDir, workspace, uiDir, instanceId }, port);
    base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, current);

    const after = await observeHttpState(base, input);
    const afterApp = await observeAppSessionState(base, appSessionId);
    const afterDisk = {
      session: readJson(sessionPath),
      customCatalog: readJson(path.join(dataDir, "app-catalog", "custom.json")),
      persistenceSettings: readJson(path.join(dataDir, "ai-session-persistence", "settings.json")),
      appSession: readJson(path.join(dataDir, "app-sessions", appSessionId, "metadata.json")),
    };
    assert.deepEqual(after, before, "restart must restore the same authoritative HTTP state");
    assert.equal(afterDisk.session.queue.items[0].message, input.editedMessage, "AI session queue edit must survive restart");
    assert.equal(afterDisk.appSession.title, input.appSession.renamedTitle, "app session rename must survive restart");

    return normalize({
      operations: {
        edit,
        customCatalogWrite,
        persistenceSettings,
        launchedApp,
        renamedApp: { status: renamedApp.status, title: renamedApp.body?.data?.title },
      },
      before,
      beforeApp,
      afterApp,
      disk: beforeDisk,
      restartStable: true,
    }, { ...roots, appSession: appSessionId });
  } finally {
    if (current) await stopRuntime(current);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { observeProcessRestart };
