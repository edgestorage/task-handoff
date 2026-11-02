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
  const response = await fetch(`${base}${spec.path}`, {
    method: spec.method || "GET",
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
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
        ...(difference ? { difference } : {}),
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
    await compare("invalid-app-session-rename-field", {
      method: "PATCH",
      path: "/api/apps/sessions/aps_missing",
      body: { title: "Differential", unexpected: true },
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
