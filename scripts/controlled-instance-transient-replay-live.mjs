#!/usr/bin/env node
// Live provider-path evidence: real Node/Rust controlled-instance processes,
// a protocol-compatible OpenCode fixture, and the real node-agent forwarder +
// Control Plane tunnel. The fixture emits an assistant stream; each runtime
// retains the resulting transient delta and replays it to a late subscriber.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { NodeAgentInstanceEventForwarder } = require("../packages/node-agent/src/events.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { ControlPlaneNodeAgentTunnelTransport } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");

const INSTANCE_ID = "inst_transient_live";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TASK_HANDOFF_")));
}

function runtimeEnvironment({ dataDir, workspace, port, opencodeCommand }) {
  return {
    ...cleanEnvironment(),
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION: "0.0.46",
    TASK_HANDOFF_INSTANCE_ID: INSTANCE_ID,
    TASK_HANDOFF_INSTANCE_NAME: "transient-replay-instance",
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
    TASK_HANDOFF_OPENCODE_COMMAND: opencodeCommand,
    FAKE_OPENCODE_HOLD: "1",
    FAKE_OPENCODE_FAIL_RECONCILE: "1",
    FAKE_OPENCODE_DEBUG_LOG: path.join(dataDir, "fake-opencode-debug.log"),
    NODE_NO_WARNINGS: "1",
  };
}

function spawnRuntime(label, command, args, options) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return {
    label,
    child,
    logs: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function waitForHealth(base, runtime) {
  let lastError;
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/api/health`);
        return response.ok;
      } catch (error) {
        lastError = error;
        return false;
      }
    }, `${runtime.label} health`, 30_000);
  } catch (error) {
    throw new Error(`${error.message}\n${JSON.stringify(runtime.logs(), null, 2)}`);
  }
}

async function jsonRequest(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.headers || {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${pathname} -> ${response.status}: ${text}`);
  return body;
}

class ForwarderOutput extends EventEmitter {
  constructor(nodeId, tunnel, frames) {
    super();
    this.OPEN = WebSocket.OPEN;
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.nodeId = nodeId;
    this.tunnel = tunnel;
    this.frames = frames;
  }

  send(value) {
    const message = JSON.parse(String(value));
    this.frames.push(message);
    this.tunnel.handleMessage(this.nodeId, message);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

async function observeReplay(base, label, replaySince) {
  const bus = new ControlPlaneEventBus();
  const events = [];
  bus.on(event => events.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(bus, {
    validateInstanceScope: async (nodeId, instanceId) => nodeId === `node_${label}` && instanceId === INSTANCE_ID,
  });
  const frames = [];
  const sentFrames = [];
  const output = new ForwarderOutput(`node_${label}`, tunnel, frames);
  const forwarder = new NodeAgentInstanceEventForwarder({ listInstances: () => [{ id: INSTANCE_ID, ready: true, target: { api: base } }] }, undefined, {
    safetyIntervalMs: 60_000,
    createSocket: (url, options) => {
      const socket = new WebSocket(url, options);
      const send = socket.send.bind(socket);
      socket.send = (value) => {
        try { sentFrames.push(JSON.parse(String(value))); } catch {}
        return send(value);
      };
      return socket;
    },
  });
  try {
    forwarder.addOutput(output, { expectsTransientSubscription: true });
    forwarder.setOutputSubscription(output, {
      replaySince,
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [],
    });
    forwarder.start();
    try {
      await waitFor(() => events.some(event => event.type === "ai-session.message-delta" && event.replay === true), `${label} replayed delta`);
    } catch (error) {
      console.error("replay diagnostics", JSON.stringify({
        label,
        eventTypes: events.map(event => [event.type, event.replay === true]),
        frameTypes: frames.map(frame => frame.type),
        sentFrames,
        forwardedTransient: frames
          .filter(frame => frame.type === "node-agent.event.forwarded")
          .map(frame => frame.event?.type),
      }, null, 2));
      throw error;
    }
    await sleep(250);
    const replayed = events.filter(event => event.type === "ai-session.message-delta" && event.replay === true);
    return {
      helloCount: frames.filter(frame => frame.type === "node-agent.streams.hello").length,
      replayedDeltaCount: replayed.length,
      replayedText: replayed.map(event => event.payload?.delta || "").join(""),
      replayFlags: replayed.map(event => event.replay === true),
    };
  } finally {
    forwarder.stop();
    output.close();
  }
}

async function runRuntime(label, command, args) {
  const runtimeRoot = path.join(temporaryRoot, `${label}-runtime`);
  const dataDir = path.join(runtimeRoot, "data");
  const workspace = path.join(runtimeRoot, "workspace");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  // Managed apps resolve their executable from the instance-owned target, not
  // from PATH. Materialize the protocol fixture at the real install location.
  const managedExecutable = path.join(dataDir, "managed-apps", "native", "opencode", "bin", "opencode");
  await fs.mkdir(path.dirname(managedExecutable), { recursive: true });
  await fs.copyFile(opencodeCommand, managedExecutable);
  await fs.chmod(managedExecutable, 0o755);
  const port = await freePort();
  const runtime = spawnRuntime(label, command, [...args, "web", "--port", String(port)], {
    cwd: root,
    env: runtimeEnvironment({ dataDir, workspace, port, opencodeCommand }),
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, runtime);
  const replaySince = new Date(Date.now() - 1_000).toISOString();
  try {
    const created = await jsonRequest(base, "/api/ai-sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: "opencode",
        cwd: { type: "runtime-path", path: workspace },
        clientRequestId: `live-transient-replay-${label}`,
        message: "Hello live replay",
      }),
    });
    const sessionId = created?.data?.aiSessionId;
    if (!sessionId) throw new Error(`${label} create response missing aiSessionId: ${JSON.stringify(created)}`);
    await sleep(500);
    const replay = await observeReplay(base, label, replaySince);
    const settled = await waitFor(async () => {
      const state = await jsonRequest(base, "/api/ai-sessions/state");
      return state?.data?.snapshot?.sessions?.find(candidate => candidate.id === sessionId);
    }, `${label} session state`);
    if (!replay.replayedText.includes("Hello live replay")) {
      throw new Error(`${label} replay did not contain provider delta: ${JSON.stringify(replay)}\n${JSON.stringify(runtime.logs(), null, 2)}`);
    }
    return {
      sessionStatus: settled.status,
      sessionPhase: settled.phase,
      replay,
    };
  } catch (error) {
    console.error(`${label} runtime logs`, JSON.stringify(runtime.logs(), null, 2));
    for (const file of [
      path.join(dataDir, "logs", "app-sessions", "opencode-server", "opencode-server.log"),
      path.join(dataDir, "fake-opencode-debug.log"),
    ]) {
      try { console.error(file, await fs.readFile(file, "utf8")); } catch {}
    }
    throw error;
  } finally {
    await runtime.stop();
  }
}

let temporaryRoot;
const opencodeCommand = path.join(root, "test/fixtures/fake-opencode-cli.js");

try {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ci-transient-live-"));
  const nodeBundle = process.env.NODE_BUNDLE || "dist/controlled-instance-cli.js";
  const rustBinary = process.env.RUST_BINARY || "controlled-instance-rs/target/debug/controlled-instance-rs";
  await fs.access(path.join(root, nodeBundle));
  await fs.access(path.join(root, rustBinary));

  const node = await runRuntime("node", process.execPath, [path.join(root, nodeBundle)]);
  const rust = await runRuntime("rust", path.join(root, rustBinary), []);
  const report = { node, rust, match: JSON.stringify(node) === JSON.stringify(rust) };
  console.log(JSON.stringify(report, null, 2));
  if (!report.match) process.exitCode = 1;
} finally {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
}
