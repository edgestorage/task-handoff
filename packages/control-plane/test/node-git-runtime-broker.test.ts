import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { NodeGitCredentialRuntimeBroker } from "../src/node-agent/git-credentials/runtime-broker.ts";
import { NodeGitCredentialStore } from "../src/node-agent/git-credentials/store.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

test("an existing SSH invocation is rejected immediately after authorization revocation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-revoke-"));
  try {
    const store = new NodeGitCredentialStore(nodeAgentStorePaths(dataDir));
    store.init();
    store.putPayload({
      credential: {
        id: "gitcred_one", name: "SSH", kind: "ssh-key", scope: { scheme: "ssh", host: "git.example.com", pathPrefix: "/team/" },
        secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
      },
      secret: { kind: "ssh-key", privateKey: "unused-in-this-test", pinnedKnownHosts: "git.example.com ssh-ed25519 AAAA" },
    });
    store.putAuthorizationSet({ instanceId: "inst_one", generation: 1, credentialIds: ["gitcred_one"], updatedAt: timestamp });
    const broker = new NodeGitCredentialRuntimeBroker(store);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-invocation-"));
    (broker as unknown as { invocations: Map<string, unknown> }).invocations.set("invocation_one", {
      instanceId: "inst_one", remoteUrl: "ssh://git.example.com/team/repo.git", credentialId: "gitcred_one", credentialRevision: 1,
      socketPath: path.join(directory, "missing.sock"), agentPid: 999_999_999, directory,
      idleExpiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 300_000,
    });
    store.putAuthorizationSet({ instanceId: "inst_one", generation: 2, credentialIds: [], updatedAt: timestamp });
    await assert.rejects(
      broker.exchangeAgentFrame("inst_one", "invocation_one", Buffer.from([0, 0, 0, 1, 11]).toString("base64")),
      (error: { code?: string }) => error.code === "GIT_CREDENTIAL_SSH_INVOCATION_REVOKED",
    );
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SSH invocations are released at their deadline without another broker request", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-expire-"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-invocation-"));
  try {
    const store = new NodeGitCredentialStore(nodeAgentStorePaths(dataDir));
    store.init();
    const broker = new NodeGitCredentialRuntimeBroker(store, { idleTtlMs: 20, maxTtlMs: 50 });
    (broker as unknown as { invocations: Map<string, unknown>; scheduleCleanup(): void }).invocations.set("invocation_one", {
      instanceId: "inst_one", remoteUrl: "ssh://git.example.com/team/repo.git", credentialId: "gitcred_one", credentialRevision: 1,
      socketPath: path.join(directory, "missing.sock"), agentPid: 999_999_999, directory,
      idleExpiresAt: Date.now() + 20, absoluteExpiresAt: Date.now() + 50,
    });
    (broker as unknown as { scheduleCleanup(): void }).scheduleCleanup();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fs.existsSync(directory), false);
    assert.equal((broker as unknown as { invocations: Map<string, unknown> }).invocations.size, 0);
    broker.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SSH agent exchange rejects an incomplete response and releases the invocation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-incomplete-"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-invocation-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end(Buffer.from([0, 0, 0, 2, 11]));
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    const { store, broker } = authorizedBroker(dataDir);
    putInvocation(broker, directory, socketPath, 1_000);
    await assert.rejects(
      broker.exchangeAgentFrame("inst_one", "invocation_one", Buffer.from([0, 0, 0, 1, 11]).toString("base64")),
      (error: { code?: string }) => error.code === "GIT_CREDENTIAL_SSH_AGENT_UNAVAILABLE",
    );
    assert.equal((broker as unknown as { invocations: Map<string, unknown> }).invocations.size, 0);
    assert.equal(store.getAuthorizationSet("inst_one").credentialIds.length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SSH agent exchange is bounded by the invocation deadline", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-timeout-"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-ssh-invocation-"));
  const socketPath = path.join(directory, "agent.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    const { broker } = authorizedBroker(dataDir);
    putInvocation(broker, directory, socketPath, 30);
    await assert.rejects(
      broker.exchangeAgentFrame("inst_one", "invocation_one", Buffer.from([0, 0, 0, 1, 11]).toString("base64")),
      (error: { code?: string }) => error.code === "GIT_CREDENTIAL_SSH_AGENT_UNAVAILABLE",
    );
    assert.equal((broker as unknown as { invocations: Map<string, unknown> }).invocations.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function authorizedBroker(dataDir: string) {
  const store = new NodeGitCredentialStore(nodeAgentStorePaths(dataDir));
  store.init();
  store.putPayload({
    credential: {
      id: "gitcred_one", name: "SSH", kind: "ssh-key", scope: { scheme: "ssh", host: "git.example.com", pathPrefix: "/team/" },
      secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
    },
    secret: { kind: "ssh-key", privateKey: "unused", pinnedKnownHosts: "git.example.com ssh-ed25519 AAAA" },
  });
  store.putAuthorizationSet({ instanceId: "inst_one", generation: 1, credentialIds: ["gitcred_one"], updatedAt: timestamp });
  return { store, broker: new NodeGitCredentialRuntimeBroker(store) };
}

function putInvocation(broker: NodeGitCredentialRuntimeBroker, directory: string, socketPath: string, ttlMs: number) {
  (broker as unknown as { invocations: Map<string, unknown> }).invocations.set("invocation_one", {
    instanceId: "inst_one", remoteUrl: "ssh://git.example.com/team/repo.git", credentialId: "gitcred_one", credentialRevision: 1,
    socketPath, agentPid: 999_999_999, directory,
    idleExpiresAt: Date.now() + ttlMs, absoluteExpiresAt: Date.now() + ttlMs,
  });
}
