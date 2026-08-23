import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { NodeAgentRegistrationClient } from "./node-agent-client.ts";
import { parseGitSshInvocation, remoteFromHttpsCredentialRequest, runSsh } from "./git-transport.ts";

type BrokerResponse = Record<string, unknown> & { status: string };
type LocalSshInvocation = { server: net.Server; directory: string; invocationId: string };

function brokerError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function credentialFailure(status: string) {
  const marker = status.toUpperCase().replace(/-/g, "_");
  return brokerError(`GIT_CREDENTIAL_${marker}`, `TASK_HANDOFF_GIT_CREDENTIAL_ERROR=${marker}`);
}

function safeSocketPath(value: string | undefined) {
  if (value?.trim()) return value.trim();
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  return path.join(temporaryRoot, `task-handoff-git-proxy-${process.pid}`, "broker.sock");
}

export class GitCredentialBroker {
  private server?: net.Server;
  private requestCount = 0;
  private readonly sshInvocations = new Map<string, LocalSshInvocation>();
  readonly socketPath: string;
  readonly runtimeDir: string;
  private readonly options: {
    socketPath?: string;
    runtimeDir?: string;
    nodeAgentClient?: () => NodeAgentRegistrationClient;
  };

  constructor(options: {
    socketPath?: string;
    runtimeDir?: string;
    nodeAgentClient?: () => NodeAgentRegistrationClient;
  } = {}) {
    this.options = options;
    this.socketPath = safeSocketPath(options.socketPath || process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET);
    this.runtimeDir = options.runtimeDir || path.dirname(this.socketPath);
  }

  handledRequestCount() { return this.requestCount; }

  request(value: Record<string, unknown>) {
    return this.handleWireRequest(JSON.stringify(value));
  }

  async start() {
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.runtimeDir, 0o700);
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { input += chunk; if (input.length > 1024 * 1024) socket.destroy(); });
      socket.on("end", () => { void this.handleWireRequest(input).then((response) => socket.end(`${JSON.stringify(response)}\n`)); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
  }

  async close() {
    for (const id of [...this.sshInvocations.keys()]) await this.releaseSshInvocation(id);
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.socketPath, { force: true });
  }

  private client() { return this.options.nodeAgentClient?.(); }

  private async handleWireRequest(input: string): Promise<BrokerResponse> {
    this.requestCount += 1;
    try {
      const request = JSON.parse(input) as Record<string, unknown>;
      const client = this.client();
      if (!client?.enabled()) return { status: "none" };
      if (request.type === "https") {
        const remote = remoteFromHttpsCredentialRequest(request);
        return remote ? await client.resolveGitHttps(remote) : { status: "unsupported" };
      }
      if (request.type === "ssh-prepare") {
        const invocation = parseGitSshInvocation(request.args);
        if (!invocation) return { status: "unsupported" };
        const prepared = await client.prepareGitSsh(invocation.remote);
        if (prepared.status !== "ok") return prepared;
        const local = await this.createSshAgentProxy(client, prepared.invocationId);
        fs.writeFileSync(path.join(local.directory, "identity.pub"), prepared.publicIdentity, { mode: 0o600 });
        fs.writeFileSync(path.join(local.directory, "known_hosts"), prepared.pinnedKnownHosts, { mode: 0o600 });
        return {
          status: "ok",
          invocationId: prepared.invocationId,
          agentSocket: path.join(local.directory, "agent.sock"),
          publicIdentityPath: path.join(local.directory, "identity.pub"),
          knownHostsPath: path.join(local.directory, "known_hosts"),
        };
      }
      if (request.type === "ssh-release" && typeof request.invocationId === "string") {
        await this.releaseSshInvocation(request.invocationId);
        return { status: "ok" };
      }
      return { status: "unsupported" };
    } catch {
      return { status: "rejected" };
    }
  }

  private async createSshAgentProxy(client: NodeAgentRegistrationClient, invocationId: string) {
    const directory = fs.mkdtempSync(path.join(this.runtimeDir, "ssh-"));
    fs.chmodSync(directory, 0o700);
    const socketPath = path.join(directory, "agent.sock");
    const server = net.createServer((socket) => proxyAgentConnection(socket, (frame) => client.exchangeGitSshAgent(invocationId, frame.toString("base64"))));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    fs.chmodSync(socketPath, 0o600);
    const value = { server, directory, invocationId };
    this.sshInvocations.set(invocationId, value);
    return value;
  }

  private async releaseSshInvocation(invocationId: string) {
    const invocation = this.sshInvocations.get(invocationId);
    this.sshInvocations.delete(invocationId);
    if (invocation) await new Promise<void>((resolve) => invocation.server.close(() => resolve()));
    if (invocation) fs.rmSync(invocation.directory, { recursive: true, force: true });
    const client = this.client();
    if (client) await client.releaseGitSsh(invocationId).catch(() => undefined);
  }
}

function proxyAgentConnection(socket: net.Socket, exchange: (frame: Buffer) => Promise<{ frame: string }>) {
  let pending = Buffer.alloc(0);
  let chain = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0) + 4;
      if (size > 1024 * 1024 || size < 5) { socket.destroy(); return; }
      if (pending.length < size) return;
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      chain = chain.then(async () => {
        socket.write(Buffer.from((await exchange(frame)).frame, "base64"));
      }).catch(() => { socket.destroy(); });
    }
  });
}

function spawnCaptureInput(command: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error("Local Git credential lookup failed.")));
    child.stdin.end(input);
  });
}

function brokerRequest(socketPath: string, request: Record<string, unknown>) {
  return new Promise<BrokerResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("connect", () => socket.end(JSON.stringify(request)));
    socket.on("close", () => { try { resolve(JSON.parse(output) as BrokerResponse); } catch { reject(new Error("Managed Git credential proxy returned an invalid response.")); } });
  });
}

function readCredentialInput() {
  return new Promise<Record<string, string>>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(Object.fromEntries(input.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }))));
  });
}

export async function runGitCredentialHelper(action: string | undefined) {
  if (action !== "get") return;
  const socketPath = process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET;
  if (!socketPath) return;
  const input = await readCredentialInput();
  const response = await brokerRequest(socketPath, { type: "https", protocol: input.protocol, host: input.host, path: input.path });
  if (response.status === "ok") {
    process.stdout.write(`username=${response.username}\npassword=${response.password}\n\n`);
    return;
  }
  if (response.status !== "none") throw credentialFailure(response.status);
  const delegated = await delegateCredentialLookup(input);
  if (delegated) process.stdout.write(`username=${delegated.username}\npassword=${delegated.password}\n\n`);
}

async function delegateCredentialLookup(input: Record<string, string>) {
  const originalCount = Number(process.env.TASK_HANDOFF_GIT_ORIGINAL_CONFIG_COUNT || 0);
  const currentCount = Number(process.env.GIT_CONFIG_COUNT || 0);
  const env = { ...process.env, GIT_CONFIG_COUNT: String(originalCount), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
  for (let index = originalCount; index < currentCount; index += 1) {
    delete env[`GIT_CONFIG_KEY_${index}`];
    delete env[`GIT_CONFIG_VALUE_${index}`];
  }
  const request = `${Object.entries(input).map(([key, value]) => `${key}=${value}`).join("\n")}\n\n`;
  try {
    const output = await spawnCaptureInput("git", ["credential", "fill"], request, env);
    const values = Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }));
    return typeof values.username === "string" && typeof values.password === "string" ? { username: values.username, password: values.password } : undefined;
  } catch { return undefined; }
}

export async function runGitSsh(args: string[]) {
  const socketPath = process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET;
  if (!socketPath) return runSsh(args, false);
  const invocation = parseGitSshInvocation(args);
  if (!invocation) throw credentialFailure("unsupported");
  const response = await brokerRequest(socketPath, { type: "ssh-prepare", args });
  if (response.status === "none") return runSsh(invocation.args, false);
  if (response.status !== "ok" || typeof response.agentSocket !== "string" || typeof response.publicIdentityPath !== "string" || typeof response.knownHostsPath !== "string") throw credentialFailure(response.status);
  try {
    return await runSsh([
      "-F", "/dev/null", "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oIdentityFile=none", "-oStrictHostKeyChecking=yes",
      `-oUserKnownHostsFile=${response.knownHostsPath}`, "-oGlobalKnownHostsFile=/dev/null", `-oIdentityAgent=${response.agentSocket}`,
      "-i", response.publicIdentityPath, ...invocation.args,
    ], true, { SSH_AUTH_SOCK: response.agentSocket });
  } finally {
    await brokerRequest(socketPath, { type: "ssh-release", invocationId: response.invocationId }).catch(() => undefined);
  }
}

export async function runGitSshAskpass() {
  throw brokerError("GIT_CREDENTIAL_SSH_ASKPASS_UNSUPPORTED", "SSH passphrases are handled only by node-agent.");
}

export function installGitBrokerEnvironment(cliPath: string | undefined, socketPath: string) {
  if (!cliPath) return;
  const count = Number(process.env.GIT_CONFIG_COUNT || 0);
  process.env.TASK_HANDOFF_GIT_ORIGINAL_CONFIG_COUNT = String(count);
  process.env.GIT_CONFIG_COUNT = String(count + 4);
  process.env[`GIT_CONFIG_KEY_${count}`] = "credential.helper";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "";
  process.env[`GIT_CONFIG_KEY_${count + 1}`] = "credential.helper";
  process.env[`GIT_CONFIG_VALUE_${count + 1}`] = `!node ${JSON.stringify(cliPath)} git-credential-helper`;
  process.env[`GIT_CONFIG_KEY_${count + 2}`] = "credential.useHttpPath";
  process.env[`GIT_CONFIG_VALUE_${count + 2}`] = "true";
  process.env[`GIT_CONFIG_KEY_${count + 3}`] = "core.sshCommand";
  process.env[`GIT_CONFIG_VALUE_${count + 3}`] = `node ${JSON.stringify(cliPath)} git-ssh`;
  process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET = socketPath;
}
