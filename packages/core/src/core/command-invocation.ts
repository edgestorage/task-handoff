import path from "node:path";
import { resolveExecutable, type ExecutableResolverOptions } from "./executable-resolver.ts";

/**
 * A resolved, directly spawnable command invocation.
 *
 * Resolution (PATH, win32 PATHEXT, NVM, Homebrew) and the win32 interpreter
 * wrapping live here so that probing (`hasCommand`) and launching
 * (`spawnLogged`, `spawnTerminalPty`, `CommandRunner`) can never drift apart:
 * npm-installed CLIs resolve to a `.cmd` shim, and a `.cmd` shim can only be
 * started through `ComSpec /d /s /c call`.
 */
export type CommandInvocation = {
  executable: string;
  args: string[];
  /** Caller environment with the resolver's PATH/NVM/Homebrew additions merged in. */
  env: NodeJS.ProcessEnv;
  /** True when `executable` is the win32 command interpreter wrapping a `.cmd`/`.bat` shim. */
  interpreterWrapped: boolean;
};

export type CommandInvocationOptions = ExecutableResolverOptions & {
  /**
   * win32-only: when the command cannot be found on `PATH`, still treat it as a
   * `.cmd`/`.bat` shim and run it through the command interpreter.
   *
   * Node package managers always install a `.cmd` launcher on Windows, so a
   * failed lookup must not hand a bare name to `CreateProcessW`, which only
   * loads PE images and would fail the launch outright.
   */
  win32ShimWhenUnresolved?: boolean;
};

function invocationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function isCommandInterpreterShim(executable: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
}

/** The executable that `hasCommand` should probe; identical resolution to `commandInvocation`. */
export function resolveCommandExecutable(command: string, options: CommandInvocationOptions = {}) {
  return resolveExecutable(command, options)?.executable;
}

const COMMAND_INTERPRETER_METACHARACTERS = /[\s"&|<>^()[\]]/;

/**
 * `cmd.exe` re-parses everything after `/c`, so an argument that carries
 * whitespace or a metacharacter is quoted to preserve the caller's argv
 * boundary instead of being concatenated into a shell string.
 *
 * NUL and line breaks cannot be represented at all, and `%` expands even inside
 * quotes (`cmd` has no command-line escape for it), so both are rejected rather
 * than silently rewritten into something the caller did not pass.
 */
export function quoteCommandInterpreterArgument(value: string) {
  if (/[\0\r\n]/.test(value)) {
    throw invocationError("COMMAND_ARGUMENT_INVALID", "Command arguments must not contain NUL or line breaks.");
  }
  if (value.includes("%")) {
    throw invocationError(
      "COMMAND_ARGUMENT_UNSUPPORTED",
      "cmd.exe expands '%' even inside quotes, so this argument cannot be passed through a .cmd/.bat shim safely.",
    );
  }
  if (value === "") return '""';
  return COMMAND_INTERPRETER_METACHARACTERS.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function commandInvocation(
  command: string,
  args: readonly string[] = [],
  options: CommandInvocationOptions = {},
): CommandInvocation {
  const baseEnv = options.env || process.env;
  const platform = options.platform || process.platform;
  const resolution = resolveExecutable(command, options);
  const unresolvedShim = !resolution
    && options.win32ShimWhenUnresolved === true
    && platform === "win32"
    && !isCommandInterpreterShim(command, platform)
    && path.win32.extname(command) === "";
  const resolvedExecutable = resolution?.executable || (unresolvedShim ? `${command}.cmd` : command);
  const env = { ...baseEnv, ...(resolution?.env || {}) };
  if (!isCommandInterpreterShim(resolvedExecutable, platform)) {
    return { executable: resolvedExecutable, args: [...args], env, interpreterWrapped: false };
  }
  return {
    executable: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", "call", resolvedExecutable, ...args.map((arg) => quoteCommandInterpreterArgument(arg))],
    env,
    interpreterWrapped: true,
  };
}
