import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCredentialBroker, installGitBrokerEnvironment } from "./src/web/git-credential-broker.ts";
import { parseGitSshInvocation } from "./src/web/git-transport.ts";

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("connect", () => socket.end(JSON.stringify(payload)));
    socket.on("close", () => resolve(JSON.parse(output)));
  });
}

test("controlled instance HTTPS proxy asks node-agent for every operation and keeps no snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join("/private/tmp", "task-handoff-git-proxy-"));
  let token = "token-one";
  const remotes = [];
  const client = {
    enabled: () => true,
    resolveGitHttps: async (remoteUrl) => { remotes.push(remoteUrl); return { status: "ok", username: "git", password: token }; },
  };
  const broker = new GitCredentialBroker({ runtimeDir: root, socketPath: path.join(root, "broker.sock"), nodeAgentClient: () => client });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(await broker.request({ type: "https", protocol: "https", host: "git.example.com", path: "team/repo.git" }), { status: "ok", username: "git", password: "token-one" });
  token = "token-two";
  assert.deepEqual(await broker.request({ type: "https", protocol: "https", host: "git.example.com", path: "team/repo.git" }), { status: "ok", username: "git", password: "token-two" });
  assert.deepEqual(remotes, ["https://git.example.com/team/repo.git", "https://git.example.com/team/repo.git"]);
  assert.equal(JSON.stringify(broker).includes("token-two"), false);
});

test("standalone or N-1 instances return no-match without contacting a managed store", async (t) => {
  const root = fs.mkdtempSync(path.join("/private/tmp", "task-handoff-git-proxy-none-"));
  const broker = new GitCredentialBroker({ runtimeDir: root, socketPath: path.join(root, "broker.sock") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await broker.request({ type: "https", protocol: "https", host: "git.example.com", path: "repo.git" }), { status: "none" });
});

test("managed Git environment contains only helper and proxy locations", () => {
  const previous = { ...process.env };
  try {
    process.env.GIT_CONFIG_COUNT = "0";
    assert.equal(installGitBrokerEnvironment("/runtime/controlled-instance-cli.js", "/run/task-handoff/git-proxy/broker.sock"), true);
    assert.equal(process.env.GIT_CONFIG_COUNT, "4");
    assert.match(process.env.GIT_CONFIG_VALUE_1, /git-credential-helper/);
    assert.match(process.env.GIT_CONFIG_VALUE_3, /git-ssh/);
    assert.equal(process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET, "/run/task-handoff/git-proxy/broker.sock");
    assert.doesNotMatch(JSON.stringify(process.env), /PRIVATE KEY|token-one/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("broker closes promptly while a local socket client is still connected", async (t) => {
  const root = fs.mkdtempSync(path.join("/private/tmp", "task-handoff-git-proxy-close-"));
  const broker = new GitCredentialBroker({ runtimeDir: root, socketPath: path.join(root, "broker.sock") });
  await broker.start();
  const socket = net.createConnection(broker.socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await Promise.race([
    broker.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("broker close timed out")), 500)),
  ]);
  if (!socket.destroyed) {
    await Promise.race([
      new Promise((resolve) => socket.once("close", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("client socket close timed out")), 500)),
    ]);
  }
  assert.equal(socket.destroyed, true);
});

test("managed Git capability installation reports an unavailable CLI", () => {
  assert.equal(installGitBrokerEnvironment(undefined, "/run/task-handoff/git-proxy/broker.sock"), false);
});

test("managed SSH accepts one Git service argument and rebuilds it safely", () => {
  assert.deepEqual(parseGitSshInvocation(["git@git.example.com", "git-upload-pack 'team/repo.git'"]), {
    remote: "ssh://git.example.com/team/repo.git",
    args: ["git@git.example.com", "git-upload-pack 'team/repo.git'"],
  });
  assert.deepEqual(parseGitSshInvocation(["git@git.example.com", "git-upload-pack 'team/repo'\\''s.git'"]), {
    remote: "ssh://git.example.com/team/repo's.git",
    args: ["git@git.example.com", "git-upload-pack 'team/repo'\\''s.git'"],
  });
  for (const command of [
    "git-upload-pack repo; id",
    "git-upload-pack 'repo'; id",
    "git-upload-pack \"repo$(id)\"",
    "git-upload-pack repo other",
    "git-upload-pack 'unterminated",
  ]) assert.equal(parseGitSshInvocation(["git@git.example.com", command]), undefined);
});
