import { spawn } from "node:child_process";

const ALLOWED_SUBCOMMANDS = new Set([
  "add",
  "branch",
  "checkout",
  "commit",
  "diff",
  "fetch",
  "for-each-ref",
  "ls-files",
  "pull",
  "push",
  "remote",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
  "update-index",
  "worktree",
  "write-tree",
]);

export type GitProcessOptions = {
  gitCommand?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
  remote?: boolean;
  acceptedExitCodes?: number[];
};

export type GitProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class GitProcessError extends Error {
  readonly code: "GIT_NOT_FOUND" | "GIT_TIMEOUT" | "GIT_OUTPUT_LIMIT" | "GIT_ABORTED" | "GIT_EXIT";
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(code: GitProcessError["code"], message: string, options: { exitCode?: number; stderr?: string } = {}) {
    super(message);
    this.name = "GitProcessError";
    this.code = code;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
  }
}

export class GitProcess {
  private readonly cwd: string;
  private readonly defaults: GitProcessOptions;

  constructor(cwd: string, defaults: GitProcessOptions = {}) {
    this.cwd = cwd;
    this.defaults = defaults;
  }

  run(subcommand: string, args: string[] = [], options: GitProcessOptions = {}): Promise<GitProcessResult> {
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      throw new GitProcessError("GIT_EXIT", `Git subcommand is not allowed: ${subcommand}`);
    }
    if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new GitProcessError("GIT_EXIT", "Git arguments must be NUL-free strings.");
    }
    const gitCommand = options.gitCommand || this.defaults.gitCommand || process.env.TASK_HANDOFF_GIT_COMMAND || "git";
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? 15_000;
    const outputLimitBytes = options.outputLimitBytes ?? this.defaults.outputLimitBytes ?? 8 * 1024 * 1024;
    const signal = options.signal || this.defaults.signal;
    const remote = options.remote ?? this.defaults.remote ?? false;
    const safeArgs = subcommand === "diff" || subcommand === "show"
      ? ["--no-ext-diff", "--no-textconv", ...args]
      : args;
    const gitArgs = [
      "-c", "color.ui=false",
      "-c", "core.pager=cat",
      "-c", "pager.branch=false",
      "-c", "diff.external=",
      "-c", "diff.trustExitCode=false",
      "-c", "diff.colorMoved=false",
      subcommand,
      ...safeArgs,
    ];

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(gitCommand, gitArgs, {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnvironment(remote),
      });
      const finish = (error?: Error, result?: GitProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const terminate = (error: Error) => {
        child.kill("SIGKILL");
        finish(error);
      };
      const onAbort = () => terminate(new GitProcessError("GIT_ABORTED", "Git operation was aborted."));
      const timer = setTimeout(() => terminate(new GitProcessError("GIT_TIMEOUT", `Git operation exceeded ${timeoutMs}ms.`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes + stderrBytes > outputLimitBytes) return terminate(new GitProcessError("GIT_OUTPUT_LIMIT", `Git output exceeded ${outputLimitBytes} bytes.`));
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > outputLimitBytes) return terminate(new GitProcessError("GIT_OUTPUT_LIMIT", `Git output exceeded ${outputLimitBytes} bytes.`));
        stderr.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ENOENT"
          ? new GitProcessError("GIT_NOT_FOUND", "Git executable is unavailable.")
          : new GitProcessError("GIT_EXIT", redactGitDiagnostic(error.message)));
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = redactGitDiagnostic(Buffer.concat(stderr).toString("utf8"));
        const acceptedExitCodes = options.acceptedExitCodes || this.defaults.acceptedExitCodes || [];
        if (exitCode !== 0 && !acceptedExitCodes.includes(exitCode ?? -1)) {
          return finish(new GitProcessError("GIT_EXIT", stderrText.trim() || `Git exited with code ${exitCode}.`, { exitCode: exitCode ?? undefined, stderr: stderrText }));
        }
        finish(undefined, { stdout: stdoutText, stderr: stderrText, exitCode: exitCode ?? 0 });
      });
    });
  }
}

export function gitEnvironment(remote: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (remote) {
    env.GCM_INTERACTIVE = "Never";
    if (!env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET) {
      // Compatibility for v0.0.21: old instances have no broker and retain the
      // existing non-interactive Repository transport behavior.
      env.GIT_ASKPASS = process.platform === "win32" ? "cmd /c exit 1" : "/bin/false";
      env.SSH_ASKPASS = env.GIT_ASKPASS;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes";
    }
  }
  return env;
}

export function redactGitDiagnostic(value: string) {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1***@")
    .replace(/\b(?:ghp|github_pat|glpat|xox[baprs])-[-_a-zA-Z0-9]+\b/g, "***")
    .replace(/([?&](?:access_token|token|key|password|signature)=)[^&\s]+/gi, "$1***")
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, "$1***")
    .replace(/(?:\/run\/task-handoff\/git-broker|\/private\/tmp\/task-handoff-git-broker|\/tmp\/task-handoff-git-broker)[^\s'\"]*/g, "[git-broker-runtime]");
}
