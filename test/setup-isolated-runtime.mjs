import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-test-runtime-${process.pid}-`));
const dataDir = path.join(runtimeRoot, "data");

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
