import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

type ActiveAgentMode = "codex" | "claude";

type ActiveAgentCommandSpec = {
  command: string;
  args: string[];
  sessionId?: string;
  stdin: boolean;
};

type ActiveAgentRunOptions = {
  mode: string;
  prompt: string;
  sessionId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnOptions?: SpawnOptionsWithoutStdio;
  spawnFn?: typeof spawn;
  onProgress?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onCancelReady?: (cancel: () => boolean) => void;
};

type ActiveAgentRunResult = {
  output: string;
  outputJsonl: string;
  sessionId?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ActiveAgentCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputPath: string;
  prompt?: string;
  sessionId?: string;
};

type ActiveAgentAdapter = {
  mode: ActiveAgentMode;
  commandSpec: (options: ActiveAgentCommandOptions) => ActiveAgentCommandSpec;
  parseSessionIdLine: (line: string) => string | undefined;
  summarizeJsonLine: (line: string) => string | undefined;
  parseFinalMessage: (outputJsonl: string) => string;
  summarizeFailure: (outputJsonl: string, stderr: string) => string;
  sessionId: (output: string) => string | undefined;
};

export type {
  ActiveAgentAdapter,
  ActiveAgentCommandOptions,
  ActiveAgentCommandSpec,
  ActiveAgentMode,
  ActiveAgentRunOptions,
  ActiveAgentRunResult,
};
