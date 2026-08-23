import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitCredentialBroker, installGitBrokerEnvironment } from "./src/web/git-credential-broker.ts";

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
    installGitBrokerEnvironment("/runtime/controlled-instance-cli.js", "/run/task-handoff/git-proxy/broker.sock");
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
