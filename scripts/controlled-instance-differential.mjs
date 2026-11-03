#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredKeys = new Set([
  "at",
  "checkedAt",
  "createdAt",
  "discoveryCorrections",
  "discoveryUnchanged",
  "generatedAt",
  "gitCommit",
  "hostname",
  "lastEventAt",
  "lastHeartbeatAt",
  "node",
  "observedAt",
  "pid",
  "processId",
  "processIncarnationId",
  "profileId",
  "revision",
  "sequence",
  "serverTime",
  "startIdentity",
  "startedAt",
  "stateRevision",
  "streamId",
  "timestamp",
  "updatedAt",
  "uptimeSeconds",
]);

function usage() {
  return [
    "Usage: node scripts/controlled-instance-differential.mjs [options]",
    "",
    "Options:",
    "  --node-bundle <path>   Current Node controlled-instance bundle",
    "  --rust-binary <path>   Rust controlled-instance binary",
    "  --ui-dir <path>        Static UI directory served by both runtimes",
    "  --out <path>           Write a JSON evidence report",
    "  --keep                 Keep temporary data and logs",
    "  --help                 Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--keep") options.keep = true;
    else if (["--node-bundle", "--rust-binary", "--ui-dir", "--out"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function executableOrDefault(explicit, candidates) {
  if (explicit) return explicit;
  for (const candidate of candidates) {
    const target = path.resolve(root, candidate);
    try {
      await fs.access(target);
      return target;
    } catch {
      // Try the next build profile.
    }
  }
  throw new Error(`Controlled-instance binary not found; checked: ${candidates.join(", ")}`);
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
  if (!port) throw new Error("Unable to allocate a test port");
  return port;
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TASK_HANDOFF_") && name !== "WORKSPACE"));
}

function runtimeEnvironment({ dataDir, workspace, port }) {
  return {
    ...cleanEnvironment(),
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION: "0.0.46",
    TASK_HANDOFF_INSTANCE_ID: "inst_differential",
    TASK_HANDOFF_INSTANCE_NAME: "differential-instance",
    TASK_HANDOFF_REGISTRATION_TOKEN: "test-registration-token",
    TASK_HANDOFF_DATA_DIR: dataDir,
    TASK_HANDOFF_WORKSPACE: workspace,
    TASK_HANDOFF_WEB_HOST: "127.0.0.1",
    TASK_HANDOFF_WEB_PORT: String(port),
    TASK_HANDOFF_HEARTBEAT_INTERVAL_MS: "600000",
    TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS: "600000",
    TASK_HANDOFF_AI_SESSION_PUBLISH_DEBOUNCE_MS: "1",
    TASK_HANDOFF_AI_SESSION_DELTA_COALESCE_MS: "32",
    TASK_HANDOFF_APP_SESSION_PERSIST: "0",
    NODE_NO_WARNINGS: "1",
  };
}

async function writeMinimalUi(directory) {
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  await fs.writeFile(path.join(directory, "index.html"), "<!doctype html><html><head><title>Differential UI</title></head><body><main id=\"app\">differential-ui-shell</main><script src=\"/assets/app.js\"></script></body></html>\n");
  await fs.writeFile(path.join(directory, "assets", "app.js"), "globalThis.__controlledInstanceDifferential = true;\n");
}

function spawnRuntime(label, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
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
    label,
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
      throw new Error(`${runtime.label} exited before becoming healthy:\n${logs.stderr || logs.stdout}`);
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
  throw new Error(`${runtime.label} did not become healthy: ${lastError?.message}\n${logs.stderr || logs.stdout}`);
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
  const result = await Promise.race([runtime.exited, timeout]);
  if (result === undefined && runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
}

function normalizeString(value, roots) {
  let normalized = value;
  for (const [name, target] of Object.entries(roots)) {
    normalized = normalized.split(target).join(`<${name}>`);
    normalized = normalized.split(target.replaceAll("\\", "/")).join(`<${name}>`);
  }
  return normalized
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(app|aps|ais|att|brp|evt|inst|job|msg|q|ses|turn|item)_[A-Za-z0-9_-]+\b/g, "<$1>")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "<hash>");
}

export function normalizeForDifferential(value, roots = {}) {
  if (Array.isArray(value)) return value.map((entry) => normalizeForDifferential(entry, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ignoredKeys.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForDifferential(entry, roots)]),
    );
  }
  if (typeof value === "string") return normalizeString(value, roots);
  return value;
}

function canonicalResponse(response, body, roots) {
  const contentType = response.headers.get("content-type") || "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return {
    status: response.status,
    mediaType,
    charset: /charset=utf-8/i.test(contentType),
    body: normalizeForDifferential(body, roots),
  };
}

async function request(base, roots, specification) {
  const spec = typeof specification === "function" ? specification() : specification;
  const headers = { ...(spec.headers || {}) };
  if (spec.body !== undefined) headers["content-type"] ||= "application/json";
  const requestBody = spec.rawBody !== undefined
    ? spec.rawBody
    : spec.body === undefined
      ? undefined
      : JSON.stringify(spec.body);
  const response = await fetch(`${base}${spec.path}`, {
    method: spec.method || "GET",
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = text;
  if (mediaTypeIsJson(response)) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, canonical: canonicalResponse(response, body, roots) };
}

function mediaTypeIsJson(response) {
  return (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
}

function findDifference(left, right, location = "$") {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right) return { location, left, right };
  if (left === null || right === null) return { location, left, right };
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return { location, left, right };
    if (left.length !== right.length) return { location: `${location}.length`, left: left.length, right: right.length };
    for (let index = 0; index < left.length; index += 1) {
      const nested = findDifference(left[index], right[index], `${location}[${index}]`);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    for (const key of new Set([...leftKeys, ...rightKeys])) {
      if (!(key in left) || !(key in right)) {
        return { location: `${location}.${key}`, left: left[key], right: right[key] };
      }
      const nested = findDifference(left[key], right[key], `${location}.${key}`);
      if (nested) return nested;
    }
    return undefined;
  }
  return { location, left, right };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const nodeBundle = await executableOrDefault(options.nodeBundle, ["dist/controlled-instance-cli.js"]);
  const rustBinary = await executableOrDefault(options.rustBinary, [
    "controlled-instance-rs/target/release/controlled-instance-rs",
    "controlled-instance-rs/target/debug/controlled-instance-rs",
    "controlled-instance-rs/target/x86_64-unknown-linux-gnu/release/controlled-instance-rs",
  ]);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "controlled-instance-differential-"));
  const uiDir = options.uiDir || path.join(temporaryRoot, "ui");
  if (!options.uiDir) await writeMinimalUi(uiDir);
  const nodeRoot = path.join(temporaryRoot, "node-runtime");
  const rustRoot = path.join(temporaryRoot, "rust-runtime");
  const nodeData = path.join(nodeRoot, "data");
  const rustData = path.join(rustRoot, "data");
  const nodeWorkspace = path.join(nodeRoot, "workspace");
  const rustWorkspace = path.join(rustRoot, "workspace");
  for (const directory of [nodeData, rustData, nodeWorkspace, rustWorkspace]) await fs.mkdir(directory, { recursive: true });
  const nodePort = await freePort();
  const rustPort = await freePort();
  const node = spawnRuntime("node", process.execPath, [nodeBundle, "web", "--port", String(nodePort), "--static-dir", uiDir], {
    cwd: root,
    env: runtimeEnvironment({ dataDir: nodeData, workspace: nodeWorkspace, port: nodePort }),
  });
  const rust = spawnRuntime("rust", rustBinary, ["web", "--port", String(rustPort), "--static-dir", uiDir], {
    cwd: root,
    env: runtimeEnvironment({ dataDir: rustData, workspace: rustWorkspace, port: rustPort }),
  });
  const nodeBase = `http://127.0.0.1:${nodePort}`;
  const rustBase = `http://127.0.0.1:${rustPort}`;
  const nodeRoots = { workspace: nodeWorkspace, data: nodeData, root: nodeRoot };
  const rustRoots = { workspace: rustWorkspace, data: rustData, root: rustRoot };
  const steps = [];
  const state = {
    node: { workspace: nodeWorkspace },
    rust: { workspace: rustWorkspace },
  };
  const startedAt = new Date().toISOString();

  try {
    await Promise.all([waitForHealth(nodeBase, node), waitForHealth(rustBase, rust)]);

    const compare = async (name, specification) => {
      const forState = (runtimeState) => typeof specification === "function" ? specification(runtimeState) : specification;
      const [nodeResult, rustResult] = await Promise.all([
        request(nodeBase, nodeRoots, () => forState(state.node)),
        request(rustBase, rustRoots, () => forState(state.rust)),
      ]);
      const difference = findDifference(nodeResult.canonical, rustResult.canonical);
      steps.push({
        name,
        status: difference ? "mismatch" : "match",
        request: forState(state.node),
        ...(difference ? { difference, node: nodeResult.canonical, rust: rustResult.canonical } : {}),
      });
      if (difference) {
        console.error(`MISMATCH ${name}: ${JSON.stringify(difference)}`);
      } else {
        console.log(`MATCH ${name}`);
      }
      return { node: nodeResult, rust: rustResult, difference };
    };

    const readRoutes = [
      ["health", "/api/health"],
      ["auth-status", "/api/auth/status"],
      ["status", "/api/status"],
      ["instance-status", "/api/instance/status"],
      ["instance-capabilities", "/api/instance/capabilities"],
      ["workspace-status", "/api/workspace/status"],
      ["app-catalog", "/api/apps/catalog"],
      ["app-management", "/api/apps/management"],
      ["custom-app-catalog", "/api/apps/catalog/custom"],
      ["ai-sessions", "/api/ai-sessions"],
      ["ai-sessions-state", "/api/ai-sessions/state"],
      ["ai-session-history", "/api/ai-sessions/history"],
      ["triggers", "/api/triggers"],
      ["trigger-runs", "/api/triggers/runs"],
      ["config-sync-presets", "/api/config-sync/presets"],
      ["config-sync-programs", "/api/config-sync/programs"],
      ["diagnostics", "/api/diagnostics"],
      ["unknown-json-api", "/api/does-not-exist"],
      ["spa-deep-link", "/triggers"],
      ["spa-unknown-route", "/unknown-ui-route"],
    ];
    for (const [name, route] of readRoutes) await compare(name, { path: route });

    // Capability probing is intentionally asynchronous in both runtimes. The
    // first document may lose the version race; after warm-up both must expose
    // the same artifact-derived capabilities.
    await new Promise((resolve) => setTimeout(resolve, 750));
    await compare("instance-capabilities-after-warmup", { path: "/api/instance/capabilities" });

    await compare("status-method-not-allowed", { method: "POST", path: "/api/status", body: {} });
    await compare("unknown-route-invalid-json", {
      method: "POST",
      path: "/api/does-not-exist",
      headers: { "content-type": "application/json" },
      rawBody: "{",
    });
    await compare("method-not-allowed-invalid-json", {
      method: "POST",
      path: "/api/status",
      headers: { "content-type": "application/json" },
      rawBody: "{",
    });
    await compare("empty-body-without-content-type", {
      method: "POST",
      path: "/api/ai-sessions",
    });
    await compare("typed-empty-body-without-content-type", {
      method: "POST",
      path: "/api/apps/browser/install",
    });
    await compare("draft-stream-null-body", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      headers: { "content-type": "application/json" },
      rawBody: "null",
    });
    await compare("draft-stream-empty-body-without-content-type", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
    });
    await compare("empty-json-body", {
      method: "POST",
      path: "/api/ai-sessions",
      headers: { "content-type": "application/json" },
      rawBody: "",
    });
    await compare("invalid-json-body", {
      method: "POST",
      path: "/api/ai-sessions",
      headers: { "content-type": "application/json" },
      rawBody: "{",
    });
    await compare("text-plain-body", {
      method: "POST",
      path: "/api/ai-sessions",
      headers: { "content-type": "text/plain" },
      rawBody: "hello",
    });
    await compare("empty-text-plain-body", {
      method: "POST",
      path: "/api/ai-sessions",
      headers: { "content-type": "text/plain" },
      rawBody: "",
    });
    for (const [name, rawBody] of [
      ["json-null-body", "null"],
      ["json-false-body", "false"],
      ["json-zero-body", "0"],
      ["json-empty-string-body", '""'],
      ["json-array-body", "[]"],
    ]) {
      await compare(name, {
        method: "POST",
        path: "/api/ai-sessions",
        headers: { "content-type": "application/json" },
        rawBody,
      });
    }
    for (const [name, rawBody] of [
      ["typed-json-null-body", "null"],
      ["typed-json-false-body", "false"],
      ["typed-json-zero-body", "0"],
      ["typed-json-empty-string-body", '""'],
    ]) {
      await compare(name, {
        method: "POST",
        path: "/api/apps/browser/install",
        headers: { "content-type": "application/json" },
        rawBody,
      });
    }
    await compare("unsupported-json-media-type", {
      method: "POST",
      path: "/api/ai-sessions",
      headers: { "content-type": "application/xml" },
      rawBody: "<session />",
    });
    for (const [name, suffix, rawBody] of [
      ["story-content-get-null", "/get", "null"],
      ["story-content-get-primitive", "/get", '"value"'],
      ["story-content-set-null", "/set", "null"],
      ["story-content-set-array", "/set", "[]"],
    ]) {
      await compare(name, {
        method: "POST",
        path: `/api/ai-sessions/ses_missing/story-content${suffix}`,
        headers: { "content-type": "application/json" },
        rawBody,
      });
    }
    await compare("story-content-get-empty-body-without-content-type", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/story-content/get",
    });
    await compare("story-content-set-empty-body-without-content-type", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/story-content/set",
    });
    await compare("oversized-json-body", {
      method: "POST",
      path: "/api/triggers",
      body: { padding: "x".repeat(1024 * 1024) },
    });
    await compare("invalid-trigger-body", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Invalid",
        source: { type: "schedule", intervalMs: 60000 },
        action: { promptTemplate: "Run" },
        deployment: { target: { type: "ai-session", aiSessionId: "ses_missing" } },
      },
    });
    await compare("invalid-trigger-empty-create", {
      method: "POST",
      path: "/api/triggers",
      body: {},
    });
    await compare("invalid-trigger-unknown-field", {
      method: "POST",
      path: "/api/triggers",
      body: { future: true },
    });
    await compare("invalid-trigger-name", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "   ",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-description", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        description: 1,
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-source-missing", {
      method: "POST",
      path: "/api/triggers",
      body: { name: "Trigger", action: { promptTemplate: "Run" } },
    });
    await compare("invalid-trigger-source-type", {
      method: "POST",
      path: "/api/triggers",
      body: { name: "Trigger", source: { type: "future" }, action: { promptTemplate: "Run" } },
    });
    await compare("invalid-trigger-schedule-interval", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 999 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-schedule-interval-unsafe", {
      method: "POST",
      path: "/api/triggers",
      headers: { "content-type": "application/json" },
      rawBody: '{"name":"Unsafe","source":{"type":"schedule","scheduleKind":"interval","intervalMs":9007199254740992},"action":{"promptTemplate":"Run"}}',
    });
    await compare("valid-trigger-schedule-interval-exponent", {
      method: "POST",
      path: "/api/triggers",
      headers: { "content-type": "application/json" },
      rawBody: '{"name":"Exponent Trigger","source":{"type":"schedule","scheduleKind":"interval","intervalMs":6e4},"action":{"promptTemplate":"Run"},"deployment":{"target":{"type":"ai-session","aiSessionId":"ses_missing"}}}',
    });
    await compare("invalid-trigger-schedule-daily", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "daily", timeOfDay: "24:00", timezone: "" },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-schedule-weekly", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "weekly", weekdays: [], timeOfDay: "12:00", timezone: "UTC" },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-file-roots", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "file-change", roots: [], globs: ["**/*"], debounceMs: 1500 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-file-globs", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "file-change", roots: ["."], globs: [""], debounceMs: 1500 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-file-debounce", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "file-change", roots: ["."], globs: ["**/*"], debounceMs: 99 },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-ai-status", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "ai-session", statuses: ["future"] },
        action: { promptTemplate: "Run" },
      },
    });
    await compare("invalid-trigger-action", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: {},
      },
    });
    await compare("invalid-trigger-policy", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: { promptTemplate: "Run" },
        policy: { maxConcurrentRuns: 0, whenBusy: "future", future: true },
      },
    });
    await compare("invalid-trigger-deployment-target", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: { promptTemplate: "Run" },
        deployment: { target: {} },
      },
    });
    await compare("invalid-trigger-deployment-unknown", {
      method: "POST",
      path: "/api/triggers",
      body: {
        name: "Trigger",
        source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000 },
        action: { promptTemplate: "Run" },
        deployment: { target: { type: "ai-session", aiSessionId: "ses_missing" }, future: true },
      },
    });
    await compare("invalid-trigger-patch-unknown", {
      method: "PATCH",
      path: "/api/triggers/trg_missing",
      body: { future: true },
    });
    await compare("invalid-trigger-patch-name", {
      method: "PATCH",
      path: "/api/triggers/trg_missing",
      body: { name: "   " },
    });
    await compare("invalid-trigger-patch-description-type", {
      method: "PATCH",
      path: "/api/triggers/trg_missing",
      body: { description: 1 },
    });
    await compare("missing-trigger-patch-null-description", {
      method: "PATCH",
      path: "/api/triggers/trg_missing",
      body: { description: null },
    });
    await compare("invalid-trigger-run-unknown", {
      method: "POST",
      path: "/api/triggers/trg_missing/run",
      body: { future: true },
    });
    await compare("missing-trigger", { path: "/api/triggers/config_missing" });
    await compare("invalid-ai-session-create", { method: "POST", path: "/api/ai-sessions", body: { agent: "unknown" } });
    await compare("missing-ai-session-create", { method: "POST", path: "/api/ai-sessions", body: {} });
    await compare("unknown-ai-session-create", {
      method: "POST",
      path: "/api/ai-sessions",
      body: {
        agent: "codex",
        cwd: { type: "runtime-path", path: "/tmp" },
        clientRequestId: "differential-invalid",
        message: "Hello",
        unexpected: true,
      },
    });
    await compare("nested-ai-session-create", {
      method: "POST",
      path: "/api/ai-sessions",
      body: {
        agent: "codex",
        cwd: { type: "runtime-path", path: "relative" },
        clientRequestId: "differential-invalid",
        message: "Hello",
        workspaceSelection: { type: "new-worktree" },
      },
    });
    await compare("attachment-ai-session-create", {
      method: "POST",
      path: "/api/ai-sessions",
      body: {
        agent: "codex",
        cwd: { type: "runtime-path", path: "/tmp" },
        clientRequestId: "differential-invalid",
        message: "Hello",
        attachments: [{ id: "  " }],
      },
    });
    await compare("invalid-ai-session-message-attachment-count", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/messages",
      body: {
        message: "Hello",
        attachments: Array.from({ length: 7 }, () => ({ id: "att_x", source: { type: "upload-ref" } })),
      },
    });
    await compare("invalid-ai-session-message-reference-count", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/messages",
      body: {
        message: "Hello",
        references: Array.from({ length: 21 }, () => ({ kind: "skill", name: "skill", path: "/tmp/skill" })),
      },
    });
    await compare("invalid-ai-session-message-attachment-field", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/messages",
      body: {
        message: "Hello",
        attachments: [{ id: "att_x", source: { type: "upload-ref" }, unexpected: true }],
      },
    });
    await compare("invalid-ai-session-message-reference-field", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/messages",
      body: {
        message: "Hello",
        references: [{ kind: "skill", name: "skill", path: "/tmp/skill", unexpected: true }],
      },
    });
    await compare("invalid-ai-session-message-codepoint-limit", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/messages",
      body: { message: "😀".repeat(20_001) },
    });
    await compare("invalid-ai-session-fork-mode", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/fork",
      body: { clientRequestId: "differential-fork", workspace: { mode: "bogus" } },
    });
    await compare("invalid-ai-session-resume-model", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/resume",
      body: { modelSelection: { modelEntityId: "model", modelName: "" } },
    });
    await compare("invalid-ai-session-resume-reasoning", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/resume",
      body: { reasoningEffort: "bogus" },
    });
    await compare("invalid-ai-session-model-selection", {
      method: "PUT",
      path: "/api/ai-sessions/ses_missing/model-selection",
      body: {
        clientRequestId: "differential-model",
        modelSelection: { modelEntityId: "model", modelName: "name", unexpected: true },
      },
    });
    await compare("invalid-ai-session-reasoning-effort", {
      method: "PUT",
      path: "/api/ai-sessions/ses_missing/reasoning-effort",
      body: { clientRequestId: "differential-reasoning", reasoningEffort: "bogus" },
    });
    await compare("invalid-ai-session-queue-attachment", {
      method: "PATCH",
      path: "/api/ai-sessions/ses_missing/queue/q_missing",
      body: {
        expectedRevision: 0,
        message: "Edit",
        attachments: [{ id: "att_x", kind: "file", source: { type: "retained" } }],
      },
    });
    await compare("invalid-ai-session-queue-reorder", {
      method: "PATCH",
      path: "/api/ai-sessions/ses_missing/queue/reorder",
      body: { expectedRevision: 0, queueIds: [""] },
    });
    await compare("invalid-ai-session-timeline-sync", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/timeline/sync",
      body: { knownItems: [{ id: "item", revision: "rev", unexpected: true }] },
    });
    await compare("invalid-ai-session-rename-expected-title", {
      method: "PUT",
      path: "/api/ai-sessions/ses_missing/title",
      body: { title: "Renamed", expectedTitle: "x".repeat(241), clientRequestId: "differential-rename" },
    });
    await compare("invalid-attachment-complete-body", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams/cia_0123456789abcdef01234567/complete",
      body: { unexpected: true },
    });
    await compare("invalid-attachment-upload-query-empty", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts",
      rawBody: "",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-query-unknown", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=1&future=1",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-query-size", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=1.5",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-query-zero-size", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=0",
      rawBody: "",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-session-order", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=session&scopeId=ses_missing&kind=file&name=file.txt&mime=text/plain&size=1",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-image-mime", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=image&name=file.txt&mime=text/plain&size=1",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-content-size", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=2",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-upload-media-type", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=1",
      rawBody: "x",
      headers: { "content-type": "application/pdf" },
    });
    await compare("invalid-attachment-upload-missing-media-type", {
      method: "POST",
      path: "/api/ai-session-attachments/drafts?scopeType=create-request&scopeId=scope&kind=file&name=file.txt&mime=text/plain&size=1",
      rawBody: "x",
      headers: { "content-type": "" },
    });
    await compare("invalid-attachment-stream-begin-empty", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      body: {},
    });
    await compare("invalid-attachment-stream-begin-id", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      body: {
        attachmentId: "bad",
        scopeType: "session",
        scopeId: "ses_missing",
        kind: "file",
        name: "file.txt",
        mime: "text/plain",
        size: 1,
      },
    });
    await compare("invalid-attachment-stream-begin-unknown", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      body: {
        attachmentId: "cia_0123456789abcdef01234567",
        scopeType: "session",
        scopeId: "ses_missing",
        kind: "file",
        name: "file.txt",
        mime: "text/plain",
        size: 1,
        future: true,
      },
    });
    await compare("invalid-attachment-stream-begin-size-null", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      body: {
        attachmentId: "cia_0123456789abcdef01234567",
        scopeType: "session",
        scopeId: "ses_missing",
        kind: "file",
        name: "file.txt",
        mime: "text/plain",
        size: null,
      },
    });
    await compare("missing-attachment-stream-begin-session", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams",
      body: {
        attachmentId: "cia_0123456789abcdef01234567",
        scopeType: "session",
        scopeId: "ses_missing",
        kind: "file",
        name: "file.txt",
        mime: "text/plain",
        size: 1,
      },
    });
    await compare("invalid-attachment-stream-append-id", {
      method: "PUT",
      path: "/api/ai-session-attachments/draft-streams/bad?offset=0",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-stream-append-offset-missing", {
      method: "PUT",
      path: "/api/ai-session-attachments/draft-streams/cia_0123456789abcdef01234567",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-stream-append-offset-unknown", {
      method: "PUT",
      path: "/api/ai-session-attachments/draft-streams/cia_0123456789abcdef01234567?offset=0&future=1",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-stream-append-offset-negative", {
      method: "PUT",
      path: "/api/ai-session-attachments/draft-streams/cia_0123456789abcdef01234567?offset=-1",
      rawBody: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    await compare("invalid-attachment-stream-complete-id", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams/bad/complete",
      body: {},
    });
    await compare("invalid-attachment-stream-complete-body-order", {
      method: "POST",
      path: "/api/ai-session-attachments/draft-streams/bad/complete",
      body: { future: true },
    });
    await compare("invalid-attachment-stream-cancel-id", {
      method: "DELETE",
      path: "/api/ai-session-attachments/draft-streams/bad",
    });
    await compare("invalid-attachment-draft-cancel-query", {
      method: "DELETE",
      path: "/api/ai-session-attachments/drafts/att_0123456789abcdef01234567?scopeType=session",
    });
    await compare("missing-attachment-draft-cancel", {
      method: "DELETE",
      path: "/api/ai-session-attachments/drafts/att_0123456789abcdef01234567?scopeType=session&scopeId=ses_missing",
    });
    await compare("invalid-app-profile-create-field", {
      method: "POST",
      path: "/api/apps/browser/profiles",
      body: { name: "Differential", unexpected: true },
    });
    await compare("invalid-app-profile-rename-field", {
      method: "PATCH",
      path: "/api/apps/browser/profiles/brp_missing",
      body: { name: "Differential", unexpected: true },
    });
    await compare("invalid-app-profile-name-utf16", {
      method: "POST",
      path: "/api/apps/browser/profiles",
      body: { name: "😀".repeat(31) },
    });
    await compare("invalid-app-session-rename-field", {
      method: "PATCH",
      path: "/api/apps/sessions/aps_missing",
      body: { title: "Differential", unexpected: true },
    });
    await compare("invalid-app-session-rename-missing-title", {
      method: "PATCH",
      path: "/api/apps/sessions/aps_missing",
      body: {},
    });
    await compare("invalid-app-session-rename-utf16", {
      method: "PATCH",
      path: "/api/apps/sessions/aps_missing",
      body: { title: "😀".repeat(61) },
    });
    await compare("valid-app-session-rename-utf16-boundary", {
      method: "PATCH",
      path: "/api/apps/sessions/aps_missing",
      body: { title: "😀".repeat(60) },
    });
    await compare("invalid-app-session-display-width", {
      method: "POST",
      path: "/api/apps/sessions/aps_missing/display",
      body: { width: 319 },
    });
    await compare("invalid-app-session-display-type", {
      method: "POST",
      path: "/api/apps/sessions/aps_missing/display",
      body: { height: "1080" },
    });
    await compare("app-session-display-integral-float", {
      method: "POST",
      path: "/api/apps/sessions/aps_missing/display",
      body: { width: 320.0 },
    });
    await compare("app-session-display-strips-unknown-field", {
      method: "POST",
      path: "/api/apps/sessions/aps_missing/display",
      body: { width: 1280, future: true },
    });
    await compare("invalid-app-management-request-id", {
      method: "POST",
      path: "/api/apps/browser/install",
      body: { requestId: 1 },
    });
    await compare("invalid-app-management-unknown-field", {
      method: "POST",
      path: "/api/apps/browser/install",
      body: { unexpected: true },
    });
    await compare("invalid-model-environment-null-key", {
      method: "PUT",
      path: "/api/internal/model-environment",
      headers: { authorization: "Bearer test-registration-token" },
      body: { OPENAI_API_KEY: null },
    });
    await compare("invalid-model-environment-key-type", {
      method: "PUT",
      path: "/api/internal/model-environment",
      headers: { authorization: "Bearer test-registration-token" },
      body: { OPENAI_BASE_URL: 42 },
    });
    await compare("model-environment-strips-unknown-key", {
      method: "PUT",
      path: "/api/internal/model-environment",
      headers: { authorization: "Bearer test-registration-token" },
      body: { OPENAI_BASE_URL: "https://models.example/v1", future: true },
    });
    await compare("invalid-model-catalog-empty", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: {},
    });
    await compare("invalid-model-catalog-null", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: null,
    });
    await compare("invalid-model-catalog-array", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: [],
    });
    await compare("invalid-model-catalog-version", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: { protocolVersion: "future", instanceId: "inst_differential", entities: [], updatedAt: "2026-11-03T00:00:00.000Z" },
    });
    await compare("invalid-model-catalog-instance", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: { protocolVersion: "2026-08-27", entities: [], updatedAt: "2026-11-03T00:00:00.000Z" },
    });
    await compare("invalid-model-catalog-updated-at", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: { protocolVersion: "2026-08-27", instanceId: "inst_differential", entities: [], updatedAt: "2026-11-03 00:00:00" },
    });
    const catalogUpdatedAt = "2026-11-03T00:00:00.000Z";
    const directCatalogEntity = (overrides = {}) => ({
      id: "entity-differential",
      protocols: ["openai-responses"],
      modelNames: [{ upstreamName: "upstream-differential", name: "Differential Model", order: 0 }],
      endpoint: "https://models.example.test/v1",
      key: "differential-key",
      ...overrides,
    });
    const relayCatalogEntity = (overrides = {}) => ({
      id: "entity-differential",
      protocols: ["openai-responses"],
      modelNames: [{ upstreamName: "upstream-differential", name: "Differential Model", order: 0 }],
      routes: [{ protocol: "openai-responses", baseUrl: "https://relay.example.test/v1" }],
      ...overrides,
    });
    const directCatalog = (overrides = {}) => ({
      protocolVersion: "2026-08-27",
      instanceId: "inst_differential",
      entities: [directCatalogEntity()],
      updatedAt: catalogUpdatedAt,
      ...overrides,
    });
    const relayCatalog = (overrides = {}) => ({
      protocolVersion: "2026-10-02",
      instanceId: "inst_differential",
      entities: [relayCatalogEntity()],
      updatedAt: catalogUpdatedAt,
      ...overrides,
    });
    for (const [name, body] of [
      ["invalid-model-catalog-missing-entities", directCatalog({ entities: undefined })],
      ["invalid-model-catalog-entities-null", directCatalog({ entities: null })],
      ["invalid-model-catalog-entity-primitive", directCatalog({ entities: [1] })],
      ["invalid-model-catalog-entity-missing-id", directCatalog({ entities: [directCatalogEntity({ id: undefined })] })],
      ["invalid-model-catalog-entity-blank-id", directCatalog({ entities: [directCatalogEntity({ id: "   " })] })],
      ["invalid-model-catalog-protocols-missing", directCatalog({ entities: [directCatalogEntity({ protocols: undefined })] })],
      ["invalid-model-catalog-protocols-empty", directCatalog({ entities: [directCatalogEntity({ protocols: [] })] })],
      ["invalid-model-catalog-protocol-unknown", directCatalog({ entities: [directCatalogEntity({ protocols: ["future"] })] })],
      ["invalid-model-catalog-model-names-missing", directCatalog({ entities: [directCatalogEntity({ modelNames: undefined })] })],
      ["invalid-model-catalog-model-names-empty", directCatalog({ entities: [directCatalogEntity({ modelNames: [] })] })],
      ["invalid-model-catalog-model-entry-primitive", directCatalog({ entities: [directCatalogEntity({ modelNames: [1] })] })],
      ["invalid-model-catalog-model-name-missing", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ order: 0 }] })] })],
      ["invalid-model-catalog-model-name-blank", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "   ", order: 0 }] })] })],
      ["invalid-model-catalog-upstream-null", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ upstreamName: null, name: "Model", order: 0 }] })] })],
      ["invalid-model-catalog-order-missing", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "Model" }] })] })],
      ["invalid-model-catalog-order-fractional", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "Model", order: 1.5 }] })] })],
      ["invalid-model-catalog-order-too-big", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "Model", order: 1000001 }] })] })],
      ["invalid-model-catalog-order-unsafe", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "Model", order: 9007199254740992 }] })] })],
      ["invalid-model-catalog-order-negative-unsafe", directCatalog({ entities: [directCatalogEntity({ modelNames: [{ name: "Model", order: -9007199254740992 }] })] })],
      ["invalid-model-catalog-endpoint-missing", directCatalog({ entities: [directCatalogEntity({ endpoint: undefined })] })],
      ["invalid-model-catalog-key-null", directCatalog({ entities: [directCatalogEntity({ key: null })] })],
      ["invalid-model-catalog-missing-updated-at", directCatalog({ updatedAt: undefined })],
      ["invalid-model-catalog-updated-at-offset", directCatalog({ updatedAt: "2026-11-03T00:00:00+00:00" })],
      ["invalid-model-catalog-updated-at-spaced", directCatalog({ updatedAt: " 2026-11-03T00:00:00.000Z" })],
      ["invalid-model-catalog-relay-routes-missing", relayCatalog({ entities: [relayCatalogEntity({ routes: undefined })] })],
      ["invalid-model-catalog-relay-routes-empty", relayCatalog({ entities: [relayCatalogEntity({ routes: [] })] })],
      ["invalid-model-catalog-relay-route-primitive", relayCatalog({ entities: [relayCatalogEntity({ routes: [1] })] })],
      ["invalid-model-catalog-relay-route-unknown-protocol", relayCatalog({ entities: [relayCatalogEntity({ routes: [{ protocol: "future", baseUrl: "https://relay.example.test/v1" }] })] })],
      ["invalid-model-catalog-relay-route-duplicate", relayCatalog({ entities: [relayCatalogEntity({ routes: [
        { protocol: "openai-responses", baseUrl: "https://relay.example.test/v1" },
        { protocol: "openai-responses", baseUrl: "https://relay.example.test/v2" },
      ] })] })],
      ["invalid-model-catalog-relay-base-url-null", relayCatalog({ entities: [relayCatalogEntity({ routes: [{ protocol: "openai-responses", baseUrl: null }] })] })],
    ]) {
      await compare(name, {
        method: "PUT",
        path: "/api/internal/model-catalog",
        headers: { authorization: "Bearer test-registration-token" },
        body,
      });
    }
    await compare("valid-model-catalog-direct-normalization", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: directCatalog({
        instanceId: "  inst_differential  ",
        future: true,
        entities: [directCatalogEntity({
          id: "  entity-differential  ",
          future: true,
          modelNames: [{
            upstreamName: "  upstream-differential  ",
            name: "  Differential Model  ",
            order: 6e4,
            future: true,
          }],
          endpoint: "  https://models.example.test/v1  ",
          key: "  differential-key  ",
        })],
      }),
    });
    await compare("valid-model-catalog-direct-state", {
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
    });
    await compare("valid-model-catalog-bom-normalization", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: directCatalog({
        instanceId: "\uFEFFinst_differential\uFEFF",
        entities: [directCatalogEntity({
          id: "\uFEFFentity-bom\uFEFF",
          modelNames: [{
            upstreamName: "\uFEFFupstream-bom\uFEFF",
            name: "\uFEFFBOM Model\uFEFF",
            order: 0,
          }],
          endpoint: "\uFEFFhttps://models.example.test/bom\uFEFF",
          key: "\uFEFFbom-key\uFEFF",
        })],
      }),
    });
    await compare("valid-model-catalog-bom-state", {
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
    });
    await compare("valid-model-catalog-order-exponent", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: {
        authorization: "Bearer test-registration-token",
        "content-type": "application/json",
      },
      rawBody: JSON.stringify(directCatalog()).replace('"order":0', '"order":6e4'),
    });
    await compare("valid-model-catalog-relay-normalization", {
      method: "PUT",
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
      body: relayCatalog({
        future: true,
        entities: [relayCatalogEntity({
          id: "  relay-entity  ",
          protocols: ["openai-responses", "anthropic-messages"],
          modelNames: [{ upstreamName: "  relay-upstream  ", name: "  Relay Model  ", order: 320.0, future: true }],
          routes: [
            { protocol: "openai-responses", baseUrl: "  https://relay.example.test/responses  ", future: true },
            { protocol: "anthropic-messages", baseUrl: "https://relay.example.test/anthropic" },
          ],
          future: true,
        })],
      }),
    });
    await compare("valid-model-catalog-relay-state", {
      path: "/api/internal/model-catalog",
      headers: { authorization: "Bearer test-registration-token" },
    });
    await compare("invalid-codex-settings-unknown-field", {
      method: "PUT",
      path: "/api/internal/codex-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { future: true },
    });
    await compare("invalid-codex-settings-verbosity", {
      method: "PUT",
      path: "/api/internal/codex-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { modelVerbosity: "bogus" },
    });
    await compare("invalid-codex-settings-multi-agent-field", {
      method: "PUT",
      path: "/api/internal/codex-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { multiAgent: { enabled: true, future: true } },
    });
    await compare("invalid-codex-settings-concurrency", {
      method: "PUT",
      path: "/api/internal/codex-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { multiAgent: { enabled: true, maxConcurrentThreads: 65 } },
    });
    await compare("invalid-node-agent-connection-url", {
      method: "PUT",
      path: "/api/internal/node-agent-connection",
      headers: { authorization: "Bearer test-registration-token" },
      body: { nodeAgentUrl: "not a url" },
    });
    await compare("invalid-node-agent-connection-unknown-field", {
      method: "PUT",
      path: "/api/internal/node-agent-connection",
      headers: { authorization: "Bearer test-registration-token" },
      body: { nodeAgentUrl: "http://127.0.0.1:1234", future: true },
    });
    await compare("invalid-ai-session-persistence-settings-missing-limit", {
      method: "PUT",
      path: "/api/internal/ai-session-persistence-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: {},
    });
    await compare("invalid-ai-session-persistence-settings-limit", {
      method: "PUT",
      path: "/api/internal/ai-session-persistence-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { historyLimit: 0 },
    });
    await compare("invalid-ai-session-persistence-settings-unknown-field", {
      method: "PUT",
      path: "/api/internal/ai-session-persistence-settings",
      headers: { authorization: "Bearer test-registration-token" },
      body: { historyLimit: 10, future: true },
    });
    await compare("missing-ai-session", { path: "/api/ai-sessions/ses_missing" });
    await compare("invalid-config-sync-batch", { method: "POST", path: "/api/config-sync", body: { programs: [] } });
    await compare("invalid-config-sync-program-type", {
      method: "POST",
      path: "/api/config-sync",
      body: { direction: "import", programIds: "codex", workspaceFolder: "." },
    });
    await compare("invalid-config-sync-program-item", {
      method: "POST",
      path: "/api/config-sync",
      body: { direction: "import", programIds: ["codex", 2], workspaceFolder: "." },
    });
    await compare("invalid-config-sync-duplicate", {
      method: "POST",
      path: "/api/config-sync",
      body: { direction: "import", programIds: ["codex", " codex "], workspaceFolder: "." },
    });
    await compare("invalid-config-sync-blank", {
      method: "POST",
      path: "/api/config-sync",
      body: { direction: "import", programIds: ["  "], workspaceFolder: "." },
    });
    await compare("unknown-config-sync-field", {
      method: "POST",
      path: "/api/config-sync",
      body: { direction: "import", programIds: ["codex"], workspaceFolder: ".", unexpected: true },
    });
    await compare("invalid-config-sync-direction", { method: "POST", path: "/api/config-sync/copy/codex", body: {} });
    await compare("invalid-config-sync-folders-depth-too-big", {
      path: "/api/config-sync/folders?depth=3",
    });
    await compare("invalid-config-sync-folders-depth-type", {
      path: "/api/config-sync/folders?depth=abc",
    });
    await compare("invalid-config-sync-folders-unknown-query", {
      path: "/api/config-sync/folders?unexpected=1",
    });

    await compare("invalid-repository-context-query", {
      path: "/api/ai-sessions/ses_missing/repository/context?unexpected=1",
    });
    await compare("invalid-repository-directories-query", {
      path: "/api/ai-sessions/ses_missing/repository/directories?path=" + "x".repeat(4097),
    });
    await compare("invalid-repository-file-search-query", {
      path: "/api/ai-sessions/ses_missing/repository/files/search?query=%20&limit=0",
    });
    await compare("invalid-repository-diff-query", {
      path: "/api/ai-sessions/ses_missing/repository/diff?path=a&scope=bogus",
    });
    await compare("invalid-repository-worktree-create", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
      body: {},
    });
    await compare("invalid-repository-worktree-remove", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees/remove",
      body: {},
    });
    await compare("invalid-repository-workspace-worktrees-list", {
      method: "POST",
      path: "/api/repository/workspace/worktrees/list",
      body: {},
    });
    await compare("invalid-repository-workspace-worktree-create", {
      method: "POST",
      path: "/api/repository/workspace/worktrees",
      body: {},
    });
    await compare("invalid-repository-workspace-worktree-remove", {
      method: "POST",
      path: "/api/repository/workspace/worktrees/remove",
      body: {},
    });
    await compare("invalid-repository-workspace-move-preflight", {
      method: "POST",
      path: "/api/repository/workspace/worktrees/move-to-main/preflight",
      body: {},
    });
    await compare("invalid-repository-workspace-move", {
      method: "POST",
      path: "/api/repository/workspace/worktrees/move-to-main",
      body: {},
    });
    await compare("invalid-repository-workspace-inspect", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/inspect",
      body: {},
    });
    await compare("invalid-repository-workspace-checkout", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/checkout",
      body: {},
    });
    await compare("invalid-repository-file-create", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: {},
    });
    await compare("invalid-repository-file-write", {
      method: "PUT",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: {},
    });
    await compare("invalid-repository-file-rename", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/files/rename",
      body: {},
    });
    await compare("invalid-repository-file-delete", {
      method: "DELETE",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: {},
    });
    await compare("invalid-repository-stage", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/index/stage",
      body: {},
    });
    await compare("invalid-repository-commit", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/commits",
      body: {},
    });
    await compare("invalid-repository-branch-create", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/branches/create",
      body: {},
    });
    await compare("invalid-repository-publish-confirmation", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/delivery/publish",
      body: {
        expectedSnapshotId: "snapshot",
        remote: "origin",
        sourceBranch: "feature",
        targetBranch: "feature",
        setUpstream: true,
      },
    });
    await compare("invalid-repository-start-ai-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/ai-sessions",
      body: {},
    });
    await compare("invalid-repository-create-worktree-ai-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees/ai-sessions",
      body: {},
    });
    await compare("invalid-repository-workspace-create-ai-session", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/create",
      body: {},
    });
    await compare("invalid-repository-workspace-cwd-null", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/inspect",
      body: { cwd: null },
    });
    await compare("invalid-repository-workspace-cwd-relative", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/inspect",
      body: { cwd: { type: "runtime-path", path: "relative" } },
    });
    await compare("invalid-repository-workspace-cwd-unknown", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/inspect",
      body: { cwd: { type: "runtime-path", path: "/tmp", future: true } },
    });
    await compare("invalid-repository-worktree-discriminator", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
      body: { mode: "future" },
    });
    await compare("invalid-repository-worktree-fields", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
      body: {
        mode: "new-branch",
        branchName: "bad name",
        startRef: "main",
        expectedSnapshotId: "snapshot",
        future: true,
      },
    });
    await compare("invalid-repository-worktree-remove-confirm", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees/remove",
      body: { expectedSnapshotId: "snapshot", worktreeId: "worktree", confirm: false },
    });
    await compare("invalid-repository-stage-empty-paths", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/index/stage",
      body: { expectedSnapshotId: "snapshot", paths: [] },
    });
    await compare("invalid-repository-stage-path-entry", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/index/stage",
      body: { expectedSnapshotId: "snapshot", paths: [{}] },
    });
    await compare("invalid-repository-stage-unknown", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/index/stage",
      body: { expectedSnapshotId: "snapshot", paths: [{ path: "a", expectedVersion: "0123456789abcdef" }], future: true },
    });
    await compare("invalid-repository-discard-confirm", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/discard/worktree",
      body: { expectedSnapshotId: "snapshot", paths: [{ path: "a", expectedVersion: "0123456789abcdef" }] },
    });
    await compare("invalid-repository-file-create-unknown", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: { path: "a", content: "", expectedAbsent: true, expectedSnapshotId: "snapshot", future: true },
    });
    await compare("invalid-repository-file-write-fields", {
      method: "PUT",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: { path: "../a", content: 1, expectedVersion: "short", expectedSnapshotId: "" },
    });
    await compare("invalid-repository-file-rename-fields", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/files/rename",
      body: {
        path: "a",
        destination: "../b",
        expectedVersion: "short",
        expectedDestinationAbsent: false,
        expectedSnapshotId: "snapshot",
      },
    });
    await compare("invalid-repository-file-delete-confirm", {
      method: "DELETE",
      path: "/api/ai-sessions/ses_missing/repository/files",
      body: { path: "a", expectedVersion: "0123456789abcdef", expectedSnapshotId: "snapshot", confirm: false },
    });
    await compare("invalid-repository-branch-create-name", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/branches/create",
      body: { expectedSnapshotId: "snapshot", name: "bad name" },
    });
    await compare("invalid-repository-fetch-remote", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/delivery/fetch",
      body: { expectedSnapshotId: "snapshot", remote: "bad name" },
    });
    await compare("repository-publish-valid-body-missing-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/delivery/publish",
      body: {
        expectedSnapshotId: "snapshot",
        remote: "origin",
        sourceBranch: "feature",
        targetBranch: "feature",
        setUpstream: false,
      },
    });
    await compare("invalid-repository-start-ai-session-agent", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/ai-sessions",
      body: { agent: "future" },
    });
    await compare("invalid-repository-start-ai-session-selection", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/ai-sessions",
      body: { agent: "codex", workspaceSelection: { type: "future" } },
    });
    await compare("invalid-repository-start-ai-session-permission", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/ai-sessions",
      body: { agent: "codex", permissionMode: "future" },
    });
    await compare("invalid-repository-create-worktree-ai-session-worktree", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees/ai-sessions",
      body: { agent: "codex", worktree: {} },
    });
    await compare("invalid-repository-workspace-create-no-selection", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/create",
      body: {
        agent: "codex",
        cwd: { type: "runtime-path", path: "/tmp" },
        message: "hello",
        clientRequestId: "differential-workspace",
      },
    });
    await compare("invalid-repository-workspace-create-both-selections", {
      method: "POST",
      path: "/api/repository/ai-session-workspace/create",
      body: {
        agent: "codex",
        cwd: { type: "runtime-path", path: "/tmp" },
        message: "hello",
        clientRequestId: "differential-workspace",
        gitSelection: { mode: "current-folder", branch: "main" },
        workspaceSelection: { type: "current-folder", branch: "main" },
      },
    });
    await compare("invalid-repository-file-read-query", {
      path: "/api/ai-sessions/ses_missing/repository/files",
    });
    await compare("invalid-repository-file-search-limit-type", {
      path: "/api/ai-sessions/ses_missing/repository/files/search?query=test&limit=bogus",
    });
    await compare("invalid-repository-diff-include-context", {
      path: "/api/ai-sessions/ses_missing/repository/diff?path=a&scope=unstaged&includeContext=yes",
    });
    await compare("invalid-repository-worktree-array-body", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
      body: [],
    });
    await compare("invalid-repository-worktree-empty-body", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
      headers: { "content-type": "application/json" },
      rawBody: "",
    });
    await compare("repository-context-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/context",
    });
    await compare("repository-changes-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/changes",
    });
    await compare("repository-worktrees-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/worktrees",
    });
    await compare("repository-branches-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/branches",
    });
    await compare("repository-remotes-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/remotes",
    });
    await compare("repository-diff-missing-session", {
      path: "/api/ai-sessions/ses_missing/repository/diff?path=a&scope=unstaged",
    });
    await compare("repository-stage-missing-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/index/stage",
      body: { expectedSnapshotId: "snapshot", paths: [{ path: "a", expectedVersion: "0123456789abcdef" }] },
    });
    await compare("repository-commit-missing-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/commits",
      body: { expectedSnapshotId: "snapshot", message: "message" },
    });
    await compare("repository-branch-create-missing-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/branches/create",
      body: { expectedSnapshotId: "snapshot", name: "feature" },
    });
    await compare("repository-pull-missing-session", {
      method: "POST",
      path: "/api/ai-sessions/ses_missing/repository/delivery/pull",
      body: { expectedSnapshotId: "snapshot" },
    });
    await compare("repository-app-session-context-missing", {
      path: "/api/apps/sessions/aps_missing/repository/context",
    });
    await compare("repository-app-session-files-missing", {
      path: "/api/apps/sessions/aps_missing/repository/directories",
    });
    await compare("repository-app-session-worktrees-missing", {
      path: "/api/apps/sessions/aps_missing/repository/worktrees",
    });

    const customCatalog = {
      items: [{
        id: "fixture-shell",
        name: "Fixture Shell",
        kind: "tty",
        description: "Differential shell fixture.",
        command: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      }],
    };
    await compare("custom-catalog-write", { method: "PATCH", path: "/api/apps/catalog/custom", body: customCatalog });
    await compare("custom-catalog-codepoint-name", {
      method: "PATCH",
      path: "/api/apps/catalog/custom",
      body: {
        items: [{ ...customCatalog.items[0], name: "😀".repeat(61) }],
      },
    });
    await compare("custom-catalog-read-back", { path: "/api/apps/catalog/custom" });
    await compare("catalog-includes-custom-app", { path: "/api/apps/catalog" });

    const launch = (runtimeState) => ({
      method: "POST",
      path: "/api/apps/sessions",
      body: {
        appId: "fixture-shell",
        title: "Differential shell",
        args: process.platform === "win32" ? ["/d", "/s", "/c", "ping -n 30 127.0.0.1 > nul"] : ["-c", "sleep 30"],
        cwd: runtimeState.workspace,
      },
    });
    const launched = await compare("create-app-session", launch);
    if (!launched.difference) {
      state.node.appSessionId = launched.node.body?.data?.id;
      state.rust.appSessionId = launched.rust.body?.data?.id;
    }
    if (state.node.appSessionId && state.rust.appSessionId) {
      await compare("read-app-session", (runtimeState) => ({ path: `/api/apps/sessions/${runtimeState.appSessionId}` }));
      await compare("invalid-app-session-rename-codepoint-utf16", (runtimeState) => ({
        method: "PATCH",
        path: `/api/apps/sessions/${runtimeState.appSessionId}`,
        body: { title: "😀".repeat(61) },
      }));
      await compare("rename-app-session", (runtimeState) => ({
        method: "PATCH",
        path: `/api/apps/sessions/${runtimeState.appSessionId}`,
        body: { title: "Differential shell renamed" },
      }));
      await compare("app-sessions-state", { path: "/api/apps/sessions/state" });
      await compare("stop-app-session", (runtimeState) => ({
        method: "POST",
        path: `/api/apps/sessions/${runtimeState.appSessionId}/stop`,
      }));
      await compare("read-stopped-app-session", (runtimeState) => ({ path: `/api/apps/sessions/${runtimeState.appSessionId}` }));
    }
    await compare("missing-app-session", { path: "/api/apps/sessions/aps_missing" });
    await compare("custom-catalog-reset", { method: "PATCH", path: "/api/apps/catalog/custom", body: { items: [] } });
    await compare("custom-catalog-final", { path: "/api/apps/catalog/custom" });

    const mismatches = steps.filter((step) => step.status === "mismatch");
    const report = {
      ok: mismatches.length === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      nodeBundle,
      rustBinary,
      uiDir,
      nodePort,
      rustPort,
      temporaryRoot,
      steps,
      nodeLogs: node.logs(),
      rustLogs: rust.logs(),
    };
    if (options.out) {
      await fs.mkdir(path.dirname(options.out), { recursive: true });
      await fs.writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(`Differential: ${steps.length - mismatches.length}/${steps.length} matched`);
    if (mismatches.length) {
      console.error(JSON.stringify(mismatches, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await Promise.all([stopRuntime(node), stopRuntime(rust)]);
    if (!options.keep) await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
