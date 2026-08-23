import { spawn } from "node:child_process";

export function remoteFromHttpsCredentialRequest(request: Record<string, unknown>) {
  const protocol = request.protocol === "https" ? "https" : undefined;
  const host = typeof request.host === "string" ? request.host.trim() : "";
  const remotePath = typeof request.path === "string" ? request.path.replace(/^\/+/, "") : "";
  return protocol && host ? `${protocol}://${host}/${remotePath}` : undefined;
}

export function parseGitSshInvocation(args: unknown) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string" || item.includes("\0"))) return undefined;
  const values = args as string[];
  let hostArgument = "";
  let port: string | undefined;
  const safeOptions: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-p" && /^\d+$/.test(values[index + 1] || "") && port === undefined) {
      const candidate = Number(values[++index]);
      if (candidate < 1 || candidate > 65_535) return undefined;
      port = String(candidate);
      continue;
    }
    if (value === "-4" || value === "-6") { safeOptions.push(value); continue; }
    if (value === "-o" && values[index + 1] === "SendEnv=GIT_PROTOCOL") { safeOptions.push("-o", values[++index]); continue; }
    if (value === "-oSendEnv=GIT_PROTOCOL") { safeOptions.push(value); continue; }
    if (value.startsWith("-")) return undefined;
    hostArgument = value;
    index += 1;
    if (index !== values.length - 1) return undefined;
    break;
  }
  if (!hostArgument || !/^(?:[a-zA-Z0-9._-]+@)?[^@\s]+$/.test(hostArgument)) return undefined;
  const host = hostArgument.replace(/^[^@]+@/, "");
  const service = values.at(-1) || "";
  const match = /^(?:git-upload-pack|git-receive-pack|git-upload-archive)\s+['\"]?([^'\"]+)['\"]?$/.exec(service);
  if (!host || !match) return undefined;
  return {
    remote: `ssh://${host}${port ? `:${port}` : ""}/${match[1].replace(/^\/+/, "")}`,
    args: [...safeOptions, ...(port ? ["-p", port] : []), hostArgument, service],
  };
}

export function runSsh(args: string[], managed: boolean, overrides: NodeJS.ProcessEnv = {}) {
  return new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    if (managed) delete env.SSH_AUTH_SOCK;
    Object.assign(env, overrides);
    const child = spawn("ssh", args, { stdio: "inherit", shell: false, env });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(Object.assign(new Error("Git SSH transport failed."), { exitCode: code, signal })));
  });
}
