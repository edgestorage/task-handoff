import { javascriptRuntimeEnvironment } from "@task-handoff/core/core/javascript-runtime";

export const WSL_BOOTSTRAP_ROOT = "/opt/task-handoff/bootstrap";
export const WSL_BOOTSTRAP_JAVASCRIPT_RUNTIME = `${WSL_BOOTSTRAP_ROOT}/js-runtime.sh`;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Forward only an explicit override; otherwise the WSL helper detects its runtime locally. */
export function wslJavaScriptRuntimeShellPrefix(env: NodeJS.ProcessEnv = process.env) {
  return Object.entries(javascriptRuntimeEnvironment(env))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}; `)
    .join("");
}

export function wslJavaScriptRuntimeCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const command = [WSL_BOOTSTRAP_JAVASCRIPT_RUNTIME, ...argv].map(shellQuote).join(" ");
  return ["sh", "-c", `${wslJavaScriptRuntimeShellPrefix(env)}${command}`];
}
