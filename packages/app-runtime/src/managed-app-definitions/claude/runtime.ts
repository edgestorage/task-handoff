import { spawnSync } from "node:child_process";
import { claudeControlSock, killClaudeDaemonJob } from "@task-handoff/core/core/claude-control-sock";
import { claudeShortFromOutput } from "../../runtime-utils";
import type { ManagedAppRuntimeExtension, ManagedAppTtyLaunchInput } from "../types";

function timeoutMs() {
  return Number(process.env.TASK_HANDOFF_CLAUDE_BG_TIMEOUT_MS) || 15_000;
}

function stopBackgroundLaunch(command: string, short: string, cwd: string, env: NodeJS.ProcessEnv) {
  try {
    spawnSync(command, ["stop", short], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs(),
    });
  } catch {
    // Preserve the original launch failure; this is a best-effort cleanup.
  }
}

function prepareClaudeTtyLaunch(input: ManagedAppTtyLaunchInput) {
  if (["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_CLAUDE_BG_DISABLED || "").toLowerCase())) {
    return {};
  }
  const bgArgs = ["--bg", ...input.args];
  const result = spawnSync(input.command, bgArgs, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs(),
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error) {
    throw Object.assign(new Error(`Claude background launch failed: ${result.error.message}`), { code: "APP_LAUNCH_FAILED" });
  }
  if (result.status !== 0) {
    throw Object.assign(new Error(`Claude background launch exited with code ${result.status}: ${output.trim()}`), { code: "APP_LAUNCH_FAILED" });
  }
  const short = claudeShortFromOutput(output);
  if (!short) {
    throw Object.assign(new Error("Claude background launch did not report a worker id."), { code: "APP_LAUNCH_FAILED" });
  }
  const controlSock = claudeControlSock(input.env);
  return {
    args: ["attach", short],
    env: {
      ...input.env,
      TASK_HANDOFF_APP_SESSION_ID: input.sessionId,
      TASK_HANDOFF_CLAUDE_SHORT: short,
      TASK_HANDOFF_CLAUDE_CONTROL_SOCK: controlSock,
    },
    ttyMode: "claude-attach" as const,
    ai: {
      agent: "claude" as const,
      claude: { short, controlSock, cwd: input.cwd },
    },
    lifecycle: {
      spawnFailed: () => stopBackgroundLaunch(input.command, short, input.cwd, input.env),
      stop: () => {
        void killClaudeDaemonJob(short, "SIGTERM", {
          sockPath: controlSock,
          timeoutMs: Number(process.env.TASK_HANDOFF_CLAUDE_CONTROL_TIMEOUT_MS) || 5000,
        });
      },
    },
  };
}

export function createClaudeRuntime(): ManagedAppRuntimeExtension {
  return {
    prepareTtyLaunch: prepareClaudeTtyLaunch,
  };
}
