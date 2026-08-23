import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { NodeGitCredentialStore } from "./store.ts";

const SSH_INVOCATION_IDLE_TTL_MS = 60_000;
const SSH_INVOCATION_MAX_TTL_MS = 5 * 60_000;

type SshInvocation = {
  instanceId: string;
  remoteUrl: string;
  credentialId: string;
  credentialRevision: number;
  socketPath: string;
  agentPid: number;
  directory: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
};

export class NodeGitCredentialRuntimeBroker {
  private readonly invocations = new Map<string, SshInvocation>();
  private readonly store: NodeGitCredentialStore;
  private readonly idleTtlMs: number;
  private readonly maxTtlMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(store: NodeGitCredentialStore, options: { idleTtlMs?: number; maxTtlMs?: number } = {}) {
    this.store = store;
    this.idleTtlMs = options.idleTtlMs ?? SSH_INVOCATION_IDLE_TTL_MS;
    this.maxTtlMs = options.maxTtlMs ?? SSH_INVOCATION_MAX_TTL_MS;
  }

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
      const timestamp = Date.now();
      this.invocations.set(invocationId, {
        instanceId,
        remoteUrl,
        credentialId: payload.credential.id,
        credentialRevision: payload.credential.revision,
        socketPath,
        agentPid,
        directory,
        idleExpiresAt: timestamp + this.idleTtlMs,
        absoluteExpiresAt: timestamp + this.maxTtlMs,
      });
      this.scheduleCleanup();
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
    const { match, payload } = this.store.resolve(instanceId, invocation.remoteUrl);
    if (
      match.status !== "unique"
      || payload?.secret.kind !== "ssh-key"
      || payload.credential.id !== invocation.credentialId
      || payload.credential.revision !== invocation.credentialRevision
    ) {
      this.release(invocationId, instanceId);
      throw brokerError("GIT_CREDENTIAL_SSH_INVOCATION_REVOKED", 403);
    }
    const frame = Buffer.from(encodedFrame, "base64");
    if (frame.length < 5 || frame.length > 1024 * 1024 || frame.readUInt32BE(0) !== frame.length - 4) {
      throw brokerError("GIT_CREDENTIAL_SSH_AGENT_FRAME_INVALID", 400);
    }
    invocation.idleExpiresAt = Math.min(invocation.absoluteExpiresAt, Date.now() + this.idleTtlMs);
    this.scheduleCleanup();
    const timeoutMs = Math.max(1, Math.min(invocation.idleExpiresAt, invocation.absoluteExpiresAt) - Date.now());
    try {
      const response = await exchangeFrame(invocation.socketPath, frame, timeoutMs);
      return { frame: response.toString("base64") };
    } catch {
      this.release(invocationId, instanceId);
      throw brokerError("GIT_CREDENTIAL_SSH_AGENT_UNAVAILABLE", 502);
    }
  }

  release(invocationId: string, instanceId?: string) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || (instanceId !== undefined && invocation.instanceId !== instanceId)) return false;
    this.invocations.delete(invocationId);
    try { process.kill(invocation.agentPid, "SIGTERM"); } catch { /* already stopped */ }
    fs.rmSync(invocation.directory, { recursive: true, force: true });
    this.scheduleCleanup();
    return true;
  }

  close() {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const id of [...this.invocations.keys()]) this.release(id);
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [id, invocation] of this.invocations) {
      if (invocation.idleExpiresAt <= now || invocation.absoluteExpiresAt <= now) this.release(id);
    }
  }

  private scheduleCleanup() {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    const deadline = Math.min(...[...this.invocations.values()].map((invocation) => Math.min(invocation.idleExpiresAt, invocation.absoluteExpiresAt)));
    if (!Number.isFinite(deadline)) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.cleanupExpired();
      this.scheduleCleanup();
    }, Math.max(0, deadline - Date.now()));
    this.cleanupTimer.unref?.();
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

function exchangeFrame(socketPath: string, frame: Buffer, timeoutMs: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let expected = 0;
    let settled = false;
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(new Error("Managed Git SSH agent exchange timed out.")));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Managed Git SSH agent closed before returning a complete frame.")));
    socket.once("close", () => finish(new Error("Managed Git SSH agent closed before returning a complete frame.")));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (!expected && data.length >= 4) {
        expected = data.readUInt32BE(0) + 4;
        if (expected < 5 || expected > 1024 * 1024) {
          finish(new Error("Managed Git SSH agent returned an invalid frame length."));
          return;
        }
      }
      if (expected && data.length >= expected) {
        finish(undefined, data.subarray(0, expected));
      }
    });
    socket.once("connect", () => socket.write(frame, (error) => {
      if (error) finish(error);
    }));
  });
}
