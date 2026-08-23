import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { NodeGitCredentialStore } from "./store.ts";

type SshInvocation = { instanceId: string; socketPath: string; agentPid: number; directory: string; expiresAt: number };

export class NodeGitCredentialRuntimeBroker {
  private readonly invocations = new Map<string, SshInvocation>();
  private readonly store: NodeGitCredentialStore;

  constructor(store: NodeGitCredentialStore) { this.store = store; }

  resolveHttps(instanceId: string, remoteUrl: string) {
    const { match, payload } = this.store.resolve(instanceId, remoteUrl);
    if (match.status !== "unique" || payload?.secret.kind !== "https-token") return { status: match.status } as const;
    return { status: "ok" as const, username: payload.secret.username, password: payload.secret.token };
  }

  async prepareSsh(instanceId: string, remoteUrl: string) {
    this.cleanupExpired();
    const { match, payload } = this.store.resolve(instanceId, remoteUrl);
    if (match.status !== "unique" || payload?.secret.kind !== "ssh-key") return { status: match.status } as const;
    const invocationId = `gitssh_${crypto.randomUUID()}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-ssh-"));
    fs.chmodSync(directory, 0o700);
    const socketPath = path.join(directory, "agent.sock");
    const askpassPath = path.join(directory, "askpass.sh");
    fs.writeFileSync(askpassPath, "#!/bin/sh\nprintf '%s' \"${TASK_HANDOFF_SSH_KEY_PASSPHRASE:-}\"\n", { mode: 0o700 });
    let agentPid: number | undefined;
    try {
      const agent = await spawnCapture("ssh-agent", ["-s", "-a", socketPath]);
      agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(agent)?.[1]);
      if (!Number.isInteger(agentPid) || agentPid <= 0) throw new Error("ssh-agent did not report a process id.");
      const env = {
        ...process.env,
        SSH_AUTH_SOCK: socketPath,
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || ":0",
        TASK_HANDOFF_SSH_KEY_PASSPHRASE: payload.secret.passphrase || "",
      };
      await spawnCaptureWithInput("ssh-add", ["-"], payload.secret.privateKey, env);
      const publicIdentity = await spawnCapture("ssh-add", ["-L"], env);
      fs.rmSync(askpassPath, { force: true });
      this.invocations.set(invocationId, { instanceId, socketPath, agentPid, directory, expiresAt: Date.now() + 60_000 });
      return { status: "ok" as const, invocationId, publicIdentity, pinnedKnownHosts: payload.secret.pinnedKnownHosts };
    } catch (error) {
      if (agentPid) try { process.kill(agentPid, "SIGTERM"); } catch { /* already stopped */ }
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async exchangeAgentFrame(instanceId: string, invocationId: string, encodedFrame: string) {
    this.cleanupExpired();
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.instanceId !== instanceId) throw brokerError("GIT_CREDENTIAL_SSH_INVOCATION_INVALID", 404);
    const frame = Buffer.from(encodedFrame, "base64");
    if (frame.length < 5 || frame.length > 1024 * 1024 || frame.readUInt32BE(0) !== frame.length - 4) {
      throw brokerError("GIT_CREDENTIAL_SSH_AGENT_FRAME_INVALID", 400);
    }
    invocation.expiresAt = Date.now() + 60_000;
    const response = await exchangeFrame(invocation.socketPath, frame);
    return { frame: response.toString("base64") };
  }

  release(invocationId: string, instanceId?: string) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || (instanceId !== undefined && invocation.instanceId !== instanceId)) return false;
    this.invocations.delete(invocationId);
    try { process.kill(invocation.agentPid, "SIGTERM"); } catch { /* already stopped */ }
    fs.rmSync(invocation.directory, { recursive: true, force: true });
    return true;
  }

  close() {
    for (const id of [...this.invocations.keys()]) this.release(id);
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [id, invocation] of this.invocations) if (invocation.expiresAt <= now) this.release(id);
  }
}

function brokerError(code: string, statusCode: number) {
  return Object.assign(new Error("Managed Git broker request was rejected."), { code, statusCode });
}

function spawnCapture(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnCaptureWithInput(command, args, undefined, env);
}

function spawnCaptureWithInput(command: string, args: string[], input: string | undefined, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => reject(new Error(`Managed Git SSH broker could not start ${command}.`)));
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(`Managed Git SSH broker command ${command} failed.`)));
    if (input !== undefined) child.stdin.end(input);
  });
}

function exchangeFrame(socketPath: string, frame: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let expected = 0;
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (!expected && data.length >= 4) expected = data.readUInt32BE(0) + 4;
      if (expected && data.length >= expected) {
        socket.destroy();
        resolve(data.subarray(0, expected));
      }
    });
    socket.once("connect", () => socket.write(frame));
  });
}
