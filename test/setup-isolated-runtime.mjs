import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Sandbox preflight. Most suites bind and dial 127.0.0.1 (control-plane HTTP, websockets, the
 * node-agent IPC bridge). When the host denies loopback, that shows up as a per-test timeout
 * minutes later, which reads like a product regression rather than a missing permission. Probe
 * once, up front, and abort with an actionable message instead of letting tests hang.
 */
async function assertLoopbackAvailable() {
  const server = net.createServer();
  try {
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  }
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-test-runtime-${process.pid}-`));
const dataDir = path.join(runtimeRoot, "data");

// A developer shell may export a live cloud environment. Tests must provide their
// own values so an ambient production or staging identity never changes trust.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("TASK_HANDOFF_CLOUD_")) delete process.env[name];
}

process.env.TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH = path.join(runtimeRoot, "control-plane.lock");
process.env.TASK_HANDOFF_NODE_AGENT_LOCK_PATH = path.join(runtimeRoot, "node-agent.lock");
process.env.TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH = path.join(runtimeRoot, "local-controlled-instance.lock");
process.env.TASK_HANDOFF_CONFIG = path.join(runtimeRoot, "config.json");
process.env.TASK_HANDOFF_DATA_DIR = dataDir;
process.env.TASK_HANDOFF_APP_CATALOG_DIR = path.join(dataDir, "app-catalog");
process.env.TASK_HANDOFF_APP_SESSION_DIR = path.join(dataDir, "app-sessions");
process.env.TASK_HANDOFF_RUNTIME_DIR = path.join(dataDir, "runtime");
process.env.TASK_HANDOFF_EVENTS_DIR = path.join(dataDir, "events");
process.env.TASK_HANDOFF_ARTIFACT_DIR = path.join(dataDir, "artifacts");
process.env.TASK_HANDOFF_LOG_DIR = path.join(dataDir, "logs");
process.env.TASK_HANDOFF_WEB_TOKEN_FILE = path.join(dataDir, "web-token");
process.env.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR = path.join(runtimeRoot, "control-plane");
process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR = path.join(runtimeRoot, "node-agent");

process.once("exit", () => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

try {
  await assertLoopbackAvailable();
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[test preflight] 127.0.0.1 loopback is unavailable (${code}: ${message}).\n`
    + "[test preflight] This suite needs loopback for its HTTP/WebSocket/IPC fixtures. Grant the test\n"
    + "[test preflight] process network access (or run it outside the sandbox) and rerun; it fails here\n"
    + "[test preflight] instead of timing out per test.\n",
  );
  process.exit(1);
}
