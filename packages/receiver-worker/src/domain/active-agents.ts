import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  codexCommand,
  codexCommandSpec,
  codexSessionId,
  lastCodexMessage,
  parseCodexFinalMessage,
  parseCodexSessionIdLine,
  summarizeCodexFailure,
  summarizeCodexJsonLine,
} from "../agents/codex";
import {
  claudeCommand,
  claudeCommandSpec,
  claudeSessionId,
  parseClaudeFinalMessage,
  parseClaudeSessionIdLine,
  summarizeClaudeFailure,
  summarizeClaudeJsonLine,
} from "../agents/claude";
import type { ActiveAgentAdapter, ActiveAgentCommandOptions, ActiveAgentMode, ActiveAgentRunOptions, ActiveAgentRunResult } from "../agents/types";

const activeAgentAdapters = new Map<ActiveAgentMode, ActiveAgentAdapter>();

function registerActiveAgentAdapter(adapter: ActiveAgentAdapter) {
  activeAgentAdapters.set(adapter.mode, adapter);
  return adapter;
}

registerActiveAgentAdapter({
  mode: "codex",
  commandSpec: codexCommandSpec,
  parseSessionIdLine: parseCodexSessionIdLine,
  summarizeJsonLine: summarizeCodexJsonLine,
  parseFinalMessage: parseCodexFinalMessage,
  summarizeFailure: summarizeCodexFailure,
  sessionId: codexSessionId,
});

registerActiveAgentAdapter({
  mode: "claude",
  commandSpec: claudeCommandSpec,
  parseSessionIdLine: parseClaudeSessionIdLine,
  summarizeJsonLine: summarizeClaudeJsonLine,
  parseFinalMessage: parseClaudeFinalMessage,
  summarizeFailure: summarizeClaudeFailure,
  sessionId: claudeSessionId,
});

function normalizeConversationMode(mode: unknown): ActiveAgentMode | "passive" {
  return mode === "codex" || mode === "claude" ? mode : "passive";
}

function isActiveConversationMode(mode: unknown) {
  return normalizeConversationMode(mode) !== "passive";
}

function activeAgentCommand({ mode, ...options }: ActiveAgentCommandOptions & { mode: string }) {
  return requireActiveAgentAdapter(mode).commandSpec(options);
}

function agentName(mode: string) {
  const agent = normalizeConversationMode(mode);
  return agent === "passive" ? mode : agent;
}

function summarizeAgentJsonLine(mode: string, line: string) {
  return requireActiveAgentAdapter(mode).summarizeJsonLine(line);
}

function parseAgentSessionIdLine(mode: string, line: string) {
  return requireActiveAgentAdapter(mode).parseSessionIdLine(line);
}

function parseAgentFinalMessage(mode: string, outputJsonl: string) {
  return requireActiveAgentAdapter(mode).parseFinalMessage(outputJsonl);
}

function summarizeAgentFailure(mode: string, outputJsonl: string, stderr: string) {
  return requireActiveAgentAdapter(mode).summarizeFailure(outputJsonl, stderr);
}

function activeAgentSessionId(mode: string, output: string) {
  return requireActiveAgentAdapter(mode).sessionId(output);
}

function requireActiveAgentAdapter(mode: string) {
  const normalized = normalizeConversationMode(mode);
  const adapter = normalized === "passive" ? undefined : activeAgentAdapters.get(normalized);
  if (!adapter) throw new Error(`Unsupported active conversation mode: ${mode}`);
  return adapter;
}

function readOutputPath(outputPath: string) {
  try {
    return fs.readFileSync(outputPath, "utf8").trim();
  } catch {
    return "";
  }
}

async function runActiveAgent({
  mode,
  prompt,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  spawnOptions = {},
  spawnFn = spawn,
  onProgress,
  onSessionId,
  onCancelReady,
}: ActiveAgentRunOptions): Promise<ActiveAgentRunResult> {
  const outputPath = path.join(os.tmpdir(), `task-handoff-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const commandSpec = activeAgentCommand({ mode, cwd, env, outputPath, prompt, sessionId });
  const { command, args } = commandSpec;

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
    });
    let closed = false;
    onCancelReady?.(() => {
      if (closed) {
        return false;
      }
      return child.kill("SIGTERM");
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let emittedSessionId = sessionId || commandSpec.sessionId || "";
    if (commandSpec.sessionId && commandSpec.sessionId !== sessionId) {
      onSessionId?.(commandSpec.sessionId);
    }

    const handleStdout = (text: string) => {
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const cleanLine = line.trim();
        const parsedSessionId = parseAgentSessionIdLine(mode, cleanLine);
        if (parsedSessionId && parsedSessionId !== emittedSessionId) {
          emittedSessionId = parsedSessionId;
          onSessionId?.(parsedSessionId);
        }
        const progress = summarizeAgentJsonLine(mode, cleanLine);
        if (progress) {
          onProgress?.(progress);
        }
      }
    };

    child.stdout?.on("data", (chunk) => {
      handleStdout(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = true;
      if (stdoutBuffer.trim()) {
        const parsedSessionId = parseAgentSessionIdLine(mode, stdoutBuffer.trim());
        if (parsedSessionId && parsedSessionId !== emittedSessionId) {
          emittedSessionId = parsedSessionId;
          onSessionId?.(parsedSessionId);
        }
        const progress = summarizeAgentJsonLine(mode, stdoutBuffer.trim());
        if (progress) {
          onProgress?.(progress);
        }
      }
      const fileOutput = readOutputPath(outputPath);
      fs.rm(outputPath, { force: true }, () => {});
      const outputJsonl = stdout.trim();
      const failed = code !== 0 || Boolean(signal);
      const failure = failed ? summarizeAgentFailure(mode, outputJsonl, stderr) : "";
      if (failed) {
        reject(new Error(failure || `${agentName(mode)} exited with ${signal || `code ${code}`}`));
        return;
      }
      const output = fileOutput || parseAgentFinalMessage(mode, outputJsonl) || stderr.trim() || outputJsonl;
      if (!output.trim()) {
        reject(new Error(`${agentName(mode)} CLI output missing final message`));
        return;
      }
      resolve({ output, outputJsonl, sessionId: sessionId || commandSpec.sessionId || activeAgentSessionId(mode, outputJsonl), code, signal });
    });
    if (commandSpec.stdin) {
      child.stdin?.end(prompt);
    } else {
      child.stdin?.end();
    }
  });
}

export {
  activeAgentCommand,
  claudeCommand,
  claudeSessionId,
  codexCommand,
  codexSessionId,
  isActiveConversationMode,
  lastCodexMessage,
  normalizeConversationMode,
  parseClaudeFinalMessage,
  parseCodexFinalMessage,
  runActiveAgent,
  registerActiveAgentAdapter,
  summarizeClaudeFailure,
  summarizeClaudeJsonLine,
  summarizeCodexFailure,
  summarizeCodexJsonLine,
};

export type { ActiveAgentMode, ActiveAgentRunOptions, ActiveAgentRunResult };
