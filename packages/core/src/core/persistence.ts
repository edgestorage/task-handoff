import os from "node:os";
import path from "node:path";

export const CONFIG_PATH =
  process.env.TASK_HANDOFF_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "task-handoff", "config.json");
