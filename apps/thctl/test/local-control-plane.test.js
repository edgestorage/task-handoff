import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { localControlPlaneLockPath, localControlPlaneOrigin } from "../src/local-control-plane.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

const LOCK_ENV = "TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH";
const LOCAL_ORIGIN = "http://127.0.0.1:18181";
const DISABLED_CAPABILITIES = {
  authentication: "disabled",
  aiSessions: true,
  nodes: true,
  instanceBoard: true,
  triggers: true,
  stories: true,
  cliSessions: false,
  localCliSessions: true,
};

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempStore() {
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-local-")));
}

function writeLock(owner) {
  const lockPath = fs.mkdtempSync(path.join(os.tmpdir(), "thctl-lock-"));
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    component: "control-plane",
    command: "control-plane --auth-mode disabled",
    acquiredAt: new Date().toISOString(),
    token: "lock-token",
    host: "127.0.0.1",
    port: 18181,
    ...owner,
  })}\n`);
  return lockPath;
}

function localSetup(options = {}) {
  const store = tempStore();
  const fake = createFakeControlPlane({
    origin: LOCAL_ORIGIN,
    capabilities: options.capabilities ?? DISABLED_CAPABILITIES,
  });
  const lockPath = options.lockPath ?? writeLock(options.owner ?? {});
  const env = { [LOCK_ENV]: lockPath };
  return { store, fake, lockPath, env };
}

test("lock discovery only trusts live loopback control planes", () => {
  const base = { hostname: os.hostname(), command: "control-plane", acquiredAt: new Date().toISOString(), token: "t" };
  assert.equal(localControlPlaneOrigin({ ...base, host: "127.0.0.1", port: 18181 }), "http://127.0.0.1:18181");
  assert.equal(localControlPlaneOrigin({ ...base, host: "::1", port: 18181 }), "http://[::1]:18181");
  assert.equal(localControlPlaneOrigin({ ...base, host: "0.0.0.0", port: 18181 }), "http://127.0.0.1:18181");
  assert.equal(localControlPlaneOrigin({ ...base, host: "192.168.1.20", port: 18181 }), undefined);
  assert.equal(localControlPlaneOrigin({ ...base, host: "127.0.0.1", port: 0 }), undefined);
  assert.equal(localControlPlaneOrigin({ ...base, host: "127.0.0.1" }), undefined);
  assert.equal(localControlPlaneLockPath({ [LOCK_ENV]: "/tmp/custom.lock" }), "/tmp/custom.lock");
  assert.match(localControlPlaneLockPath({}), /task-handoff-control-plane-/);
});

test("first run discovers the local control plane, writes a managed profile and mints a local session", async () => {
  const { store, fake, env } = localSetup();
  const output = capture();
  const code = await runCli(["node", "thctl", "whoami"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, env });
  assert.equal(code, 0, output.stderr());
  assert.match(output.stdout(), /Local Operator/);
  assert.match(output.stdout(), /local trust session/);

  const profile = store.get("local");
  assert.equal(profile.origin, LOCAL_ORIGIN);
  assert.equal(profile.source, "local-discovery");
  assert.equal(profile.controlPlaneId, "cp_fakecp0000000");
  assert.equal(store.defaultProfile(), "local");
  const credential = store.secrets().read("local");
  assert.equal(credential.mode, "local-trust");
  assert.equal(credential.sessionToken, fake.state.localSessionToken);
  assert.equal(fake.state.localSessionRequests, 1);
  assert.doesNotMatch(fs.readFileSync(store.file, "utf8"), /sessionToken/);
});

test("managed local profiles reuse credentials and re-mint after expiry", async () => {
  const { store, fake, env } = localSetup();
  const first = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: first.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, first.stderr());
  const second = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: second.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, second.stderr());
  assert.equal(fake.state.localSessionRequests, 1);
  assert.equal(fake.state.renewalCalls, 0);

  const credential = store.secrets().read("local");
  store.secrets().write("local", { ...credential, expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const third = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: third.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, third.stderr());
  assert.equal(fake.state.localSessionRequests, 2);
  assert.equal(fake.state.renewalCalls, 0);
});

test("untrusted locks are ignored instead of fabricating a local profile", async () => {
  const dead = localSetup({ owner: { pid: 4_194_303 } });
  const deadOutput = capture();
  const deadCode = await runCli(["node", "thctl", "whoami"], { store: dead.store, streams: deadOutput.streams, fetchImpl: dead.fake.fetchImpl, isTty: false, env: dead.env });
  assert.equal(deadCode, 7, deadOutput.stderr());
  assert.match(deadOutput.stderr(), /no local Control Plane was detected/);
  assert.equal(dead.store.get("local"), undefined);
  assert.equal(dead.fake.state.calls.length, 0);

  const foreign = localSetup({ owner: { host: "192.168.1.20" } });
  const foreignOutput = capture();
  const foreignCode = await runCli(["node", "thctl", "whoami"], { store: foreign.store, streams: foreignOutput.streams, fetchImpl: foreign.fake.fetchImpl, isTty: false, env: foreign.env });
  assert.equal(foreignCode, 7, foreignOutput.stderr());
  assert.equal(foreign.store.get("local"), undefined);
  assert.equal(foreign.fake.state.calls.length, 0);
});

test("an existing manual profile for the local origin is reused without a managed profile", async () => {
  const { store, fake, env } = localSetup();
  const add = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", LOCAL_ORIGIN], { store, streams: add.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, add.stderr());
  assert.ok(store.get("local-18181"));

  const output = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, output.stderr());
  assert.equal(store.get("local"), undefined);
  assert.equal(store.get("local-18181").source, undefined);
  assert.equal(store.secrets().read("local-18181").mode, "local-trust");
});

test("disabled control planes reachable only remotely refuse local sessions", async () => {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://control-plane.test", capabilities: DISABLED_CAPABILITIES });
  const add = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", "http://control-plane.test"], { store, streams: add.streams, fetchImpl: fake.fetchImpl, isTty: false, env: {} }), 0, add.stderr());
  const output = capture();
  const code = await runCli(["node", "thctl", "whoami"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, env: {} });
  assert.equal(code, 14, output.stderr());
  assert.match(output.stderr(), /only issues CLI sessions to clients on the same machine/);
  assert.equal(fake.state.localSessionRequests, 0);
  assert.equal(store.secrets().read("control-plane.test"), undefined);
});
test("a revoked local session is re-minted and the command continues", async () => {
  const { store, fake, env } = localSetup();
  const first = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: first.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, first.stderr());
  assert.equal(fake.state.localSessionRequests, 1);

  // 服务端撤销/轮换会话后，本地凭证仍在有效期内：同一次命令必须重新签发并继续。
  fake.state.localSessionToken = "csess_fakelocal_rotated00000000000.token";
  const second = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: second.streams, fetchImpl: fake.fetchImpl, isTty: false, env }), 0, second.stderr());
  assert.equal(fake.state.localSessionRequests, 2);
  assert.match(second.stdout(), /Local Operator/);
  assert.equal(store.secrets().read("local").sessionToken, fake.state.localSessionToken);
});
