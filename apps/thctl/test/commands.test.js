import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempStore() {
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-commands-")));
}

async function connect({ cliSessions = true, origin = "http://cp.test", sessionTtlMs, slowDownRemaining } = {}) {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin, cliSessions, sessionTtlMs, slowDownRemaining });
  await runCli(["node", "thctl", "profile", "add", origin], { store, streams: capture().streams, fetchImpl: fake.fetchImpl, isTty: false });
  return { store, fake };
}

async function signedIn(options = {}) {
  const { store, fake } = await connect(options);
  let polls = 0;
  const output = capture();
  const sleepDurations = [];
  const code = await runCli(["node", "thctl", "login", "--device"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    sleep: async (ms) => {
      polls += 1;
      sleepDurations.push(ms);
      if (polls >= (options.approveAfterPolls ?? 2)) fake.state.deviceApproved = true;
    },
  });
  assert.equal(code, 0, output.stderr());
  assert.ok(polls >= 2, "device login must poll until approval");
  return { store, fake, sleepDurations };
}

test("device login backs off with the server provided poll interval", async () => {
  const { store, fake, sleepDurations } = await signedIn({ slowDownRemaining: 1, approveAfterPolls: 3 });
  assert.equal(store.secrets().read("cp.test").sessionToken, fake.state.sessionToken);
  assert.ok(sleepDurations.length >= 3, `expected at least 3 polls, saw ${sleepDurations.length}`);
  assert.equal(sleepDurations[0], 1_000);
  assert.equal(sleepDurations[1], 10_000);
  assert.ok(sleepDurations[2] >= 10_000);
});

test("expiring CLI sessions renew inside the seven day window and stay untouched outside it", async () => {
  const expiring = await signedIn({ sessionTtlMs: 3 * 24 * 60 * 60 * 1000 });
  const first = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store: expiring.store, streams: first.streams, fetchImpl: expiring.fake.fetchImpl, isTty: false }), 0, first.stderr());
  assert.equal(expiring.fake.state.renewalCalls, 1);
  const renewed = expiring.store.secrets().read("cp.test");
  assert.ok(Date.parse(renewed.expiresAt) > Date.now() + 7 * 24 * 60 * 60 * 1000);

  const healthy = await signedIn();
  const second = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store: healthy.store, streams: second.streams, fetchImpl: healthy.fake.fetchImpl, isTty: false }), 0, second.stderr());
  assert.equal(healthy.fake.state.renewalCalls, 0);
});

test("device login stores a CLI credential outside the profile file", async () => {
  const { store, fake } = await signedIn();
  const credential = store.secrets().read("cp.test");
  assert.equal(credential.sessionToken, fake.state.sessionToken);
  assert.equal(credential.sessionId, "csess_fake0000000");
  assert.doesNotMatch(fs.readFileSync(store.file, "utf8"), /sessionToken|csess_/);
  assert.equal(store.get("cp.test").loginMode, "device");
});

test("device login reports denial and expiry with authentication exit codes", async () => {
  const { store, fake } = await connect();
  fake.state.deviceExpired = true;
  const output = capture();
  const code = await runCli(["node", "thctl", "login", "--device"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, sleep: async () => {},
  });
  assert.equal(code, 5, output.stderr());
  assert.match(output.stderr(), /CLI_AUTHORIZATION_EXPIRED/);
});

test("whoami reads the authoritative session and never prints the token", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "whoami", "--json"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const payload = JSON.parse(output.stdout());
  assert.equal(payload.profile, "cp.test");
  assert.equal(payload.user.primaryUsername, "admin");
  assert.equal(payload.controlPlaneId, fake.identityPayload.controlPlaneId);
  assert.doesNotMatch(output.stdout() + output.stderr(), new RegExp(fake.state.sessionToken));

  const human = capture();
  assert.equal(await runCli(["node", "thctl", "whoami"], { store, streams: human.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(human.stdout(), /Signed in to http:\/\/cp\.test as admin\./);
});

test("read commands consume the authoritative projections", async () => {
  const { store, fake } = await signedIn();
  const list = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "list", "--json"], { store, streams: list.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const listed = JSON.parse(list.stdout());
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, fake.instanceEntry.id);
  assert.equal(listed[0].status, "running");
  assert.equal(listed[0].runtime.type, "docker");
  assert.equal(listed[0].aiSessions.runningCount, 1);

  const table = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "list"], { store, streams: table.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(table.stdout(), /instance\s+name\s+status/);
  assert.match(table.stdout(), /fake-instance\s+running\s+ok\s+online/);

  const filtered = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "list", "--node", "node_other", "--json"], { store, streams: filtered.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.deepEqual(JSON.parse(filtered.stdout()), []);

  const show = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "show", "instance_fake001", "--json"], { store, streams: show.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(show.stdout()).id, "instance_fake001");

  const missing = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "show", "instance_missing"], { store, streams: missing.streams, fetchImpl: fake.fetchImpl, isTty: false }), 7);
  assert.match(missing.stderr(), /CLI_INSTANCE_NOT_FOUND/);

  const sessions = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "list", "--json"], { store, streams: sessions.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const sessionView = JSON.parse(sessions.stdout());
  assert.equal(sessionView.instances.length, 1);
  assert.deepEqual(sessionView.instances[0].aiSessions.sessions.map((session) => session.id), ["ais_fake0000001"]);
  assert.equal(sessionView.instances[0].aiSessions.sessions[0].title, "Fake session");

  const sessionTable = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "list"], { store, streams: sessionTable.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(sessionTable.stdout(), /Fake session/);

  const detail = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "show", "instance_fake001", "ais_fake0000001", "--json"], { store, streams: detail.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(detail.stdout()).detail.id, "ais_fake0000001");
});

test("write commands require explicit confirmation and honour --dry-run", async () => {
  const { store, fake } = await signedIn();
  const postsBefore = fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/stop")).length;

  const blocked = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "stop", "instance_fake001"], { store, streams: blocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/stop")).length, postsBefore);

  const dryRun = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "stop", "instance_fake001", "--dry-run"], { store, streams: dryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.dryRun, true);
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, "/api/controlled-instances/instance_fake001/stop");
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/stop")).length, postsBefore);

  const confirmed = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "stop", "instance_fake001", "--yes"], { store, streams: confirmed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/stop")).length, postsBefore + 1);
  assert.match(confirmed.stdout(), /instance_fake001\s+stopping/);

  const interactive = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "restart", "instance_fake001"], {
    store, streams: interactive.streams, fetchImpl: fake.fetchImpl, isTty: true, confirm: async () => true,
  }), 0);
  assert.match(interactive.stdout(), /restarting/);
});

test("a rejected session clears local credentials and reports authentication required", async () => {
  const { store, fake } = await signedIn();
  fake.state.sessionRevoked = true;
  const output = capture();
  const code = await runCli(["node", "thctl", "instance", "list"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false });
  assert.equal(code, 5, output.stderr());
  assert.equal(store.secrets().read("cp.test"), undefined);
  const again = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "list"], { store, streams: again.streams, fetchImpl: fake.fetchImpl, isTty: false }), 5);
  assert.match(again.stderr(), /CLI_NOT_AUTHENTICATED/);
});

test("logout revokes the server session and removes local credentials", async () => {
  const { store, fake } = await signedIn();
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "logout", "--json"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.deepEqual(JSON.parse(output.stdout()), { profile: "cp.test", revoked: true });
  assert.equal(store.secrets().read("cp.test"), undefined);
  assert.equal(fake.state.calls.some((call) => call.path === "/api/auth/cli/logout"), true);
});
