export type JavaScriptRuntimeName = "auto" | "node" | "bun";

export type ActiveJavaScriptRuntime = Exclude<JavaScriptRuntimeName, "auto">;

export function isBunRuntime(versions: NodeJS.ProcessVersions = process.versions) {
  const bun = (versions as NodeJS.ProcessVersions & { bun?: unknown }).bun;
  return typeof bun === "string" && bun.length > 0;
}

/** The runtime that is executing this process. */
export function currentJavaScriptRuntime(
  versions: NodeJS.ProcessVersions = process.versions,
): ActiveJavaScriptRuntime {
  return isBunRuntime(versions) ? "bun" : "node";
}

/** Explicit user override. `auto`, an empty value, or no value means self-detect. */
export function configuredJavaScriptRuntime(
  env: NodeJS.ProcessEnv = process.env,
): ActiveJavaScriptRuntime | undefined {
  const configured = env.TASK_HANDOFF_JS_RUNTIME?.trim().toLowerCase();
  if (!configured || configured === "auto") return undefined;
  if (configured === "node" || configured === "bun") return configured;
  throw new Error("TASK_HANDOFF_JS_RUNTIME must be auto, node, or bun.");
}

export function selectedJavaScriptRuntime(options: {
  env?: NodeJS.ProcessEnv;
  versions?: NodeJS.ProcessVersions;
} = {}): ActiveJavaScriptRuntime {
  return configuredJavaScriptRuntime(options.env) ?? currentJavaScriptRuntime(options.versions);
}

/** Explicit override forwarded to a separately spawned instance or helper. */
export function javascriptRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const runtime = configuredJavaScriptRuntime(env);
  return runtime ? { TASK_HANDOFF_JS_RUNTIME: runtime } : {};
}
