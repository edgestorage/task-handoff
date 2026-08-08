import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-test-runtime-${process.pid}-`));

process.env.TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH = path.join(runtimeRoot, "control-plane.lock");
process.env.TASK_HANDOFF_NODE_AGENT_LOCK_PATH = path.join(runtimeRoot, "node-agent.lock");
process.env.TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH = path.join(runtimeRoot, "local-controlled-instance.lock");

process.once("exit", () => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});
