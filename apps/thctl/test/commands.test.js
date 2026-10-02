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

  const renamePlan = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "rename", "instance_fake001", "renamed", "--dry-run"], { store, streams: renamePlan.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const renameRequest = JSON.parse(renamePlan.stdout());
  assert.equal(renameRequest.method, "PATCH");
  assert.equal(renameRequest.path, "/api/controlled-instances/instance_fake001");
  assert.equal(renameRequest.body.name, "renamed");

  const renamed = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "rename", "instance_fake001", "renamed", "--yes"], { store, streams: renamed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(fake.instanceEntry.name, "renamed");
  assert.match(renamed.stdout(), /renamed/);

  const interactive = capture();
  assert.equal(await runCli(["node", "thctl", "instance", "restart", "instance_fake001"], {
    store, streams: interactive.streams, fetchImpl: fake.fetchImpl, isTty: true, confirm: async () => true,
  }), 0);
  assert.match(interactive.stdout(), /restarting/);
});

test("ai-session rename requires a title and sends a confirmed PUT", async () => {
  const { store, fake } = await signedIn();

  const missingTitle = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "rename", "instance_fake001", "ais_fake0000001", "--yes"], { store, streams: missingTitle.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(missingTitle.stderr(), /CLI_OPTION_MISSING/);

  const dryRun = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "rename", "instance_fake001", "ais_fake0000001", "--title", "新标题", "--dry-run"], { store, streams: dryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.method, "PUT");
  assert.equal(plan.path, "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000001/title");
  assert.equal(plan.body.title, "新标题");
  assert.ok(plan.body.clientRequestId);

  const blocked = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "rename", "instance_fake001", "ais_fake0000001", "--title", "新标题"], { store, streams: blocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);

  const renamed = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "rename", "instance_fake001", "ais_fake0000001", "--title", "新标题", "--yes"], { store, streams: renamed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(renamed.stdout(), /renamed/);
  assert.match(renamed.stdout(), /新标题/);
  const call = fake.state.calls.find((entry) => entry.method === "PUT" && entry.path.endsWith("/title"));
  assert.equal(call.body.title, "新标题");
});

test("ai-session content reads and lifecycle mutations use the authoritative wire shapes", async () => {
  const { store, fake } = await signedIn();
  const session = "ais_fake0000001";
  const instance = "instance_fake001";

  const turns = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "turns", instance, session, "--json"], { store, streams: turns.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(turns.stdout()).index.turns[0].id, "turn_fake01");

  const turn = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "turn", instance, session, "turn_fake01", "--json"], { store, streams: turn.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(turn.stdout()).body.turn.userMessages[0].text, "Please fix the bug");

  const timeline = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "timeline", instance, session, "--json"], { store, streams: timeline.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(timeline.stdout()).items.length, 2);

  const turnTimeline = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "turn-timeline", instance, session, "turn_fake01", "--json"], { store, streams: turnTimeline.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(turnTimeline.stdout()).items.length, 3);

  const forkDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "fork", instance, session, "--dry-run"], { store, streams: forkDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const forkPlan = JSON.parse(forkDryRun.stdout());
  assert.equal(forkPlan.method, "POST");
  assert.equal(forkPlan.path, `/api/controlled-instances/${instance}/ai-sessions/${session}/fork`);
  assert.ok(forkPlan.body.clientRequestId);

  const forked = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "fork", instance, session, "--yes"], { store, streams: forked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(forked.stdout(), /ais_forked0001\s+created/);

  const closed = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "close", instance, session, "--yes"], { store, streams: closed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(closed.stdout(), /closed/);

  const model = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "model", instance, session, "--entity", "mdl_fake01", "--name", "gpt-5.6", "--yes"], { store, streams: model.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(model.stdout(), /accepted/);
  const modelCall = fake.state.calls.find((entry) => entry.method === "PUT" && entry.path.endsWith("/model-selection"));
  assert.deepEqual(modelCall.body.modelSelection, { modelEntityId: "mdl_fake01", modelName: "gpt-5.6" });

  const reasoning = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "reasoning", instance, session, "--effort", "high", "--yes"], { store, streams: reasoning.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const reasoningCall = fake.state.calls.find((entry) => entry.method === "PUT" && entry.path.endsWith("/reasoning-effort"));
  assert.equal(reasoningCall.body.reasoningEffort, "high");

  const badEffort = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "reasoning", instance, session, "--effort", "turbo", "--yes"], { store, streams: badEffort.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(badEffort.stderr(), /CLI_INVALID_OPTION/);

  const editBlocked = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "queue", "edit", instance, session, "queue_fake01", "--yes"], { store, streams: editBlocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(editBlocked.stderr(), /CLI_OPTION_MISSING/);

  const edited = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "queue", "edit", instance, session, "queue_fake01", "--message", "updated text", "--yes"], { store, streams: edited.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(edited.stdout(), /queue_fake01.*updated/);
  const editCall = fake.state.calls.find((entry) => entry.method === "PATCH" && entry.path.endsWith("/queue/queue_fake01"));
  assert.deepEqual(editCall.body, { expectedRevision: 0, message: "updated text" });

  const reordered = capture();
  assert.equal(await runCli(["node", "thctl", "ai-session", "queue", "reorder", instance, session, "--queue", "queue_fake01", "--queue", "queue_fake02", "--yes"], { store, streams: reordered.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(reordered.stdout(), /reordered/);
  const reorderCall = fake.state.calls.find((entry) => entry.method === "PATCH" && entry.path.endsWith("/queue/reorder"));
  assert.deepEqual(reorderCall.body, { expectedRevision: 0, queueIds: ["queue_fake01", "queue_fake02"] });
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

test("trigger session bindings follow the wire routes and require confirmation", async () => {
  const { store, fake } = await signedIn();
  const instance = "instance_fake001";
  const session = "ais_fake0000001";
  const configHash = "trg_fake000000000000000001";
  const bindingPath = `/api/controlled-instances/${instance}/ai-sessions/${session}/triggers`;
  const unbindPath = `${bindingPath}/${configHash}`;
  const bindCalls = () => fake.state.calls.filter((call) => call.method === "POST" && call.path === bindingPath);
  const unbindCalls = () => fake.state.calls.filter((call) => call.method === "DELETE" && call.path === unbindPath);

  const bindDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "bind", instance, session, configHash, "--dry-run"], { store, streams: bindDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const bindPlan = JSON.parse(bindDryRun.stdout());
  assert.equal(bindPlan.dryRun, true);
  assert.equal(bindPlan.method, "POST");
  assert.equal(bindPlan.path, bindingPath);
  assert.deepEqual(bindPlan.body, { configHash });
  assert.equal(bindCalls().length, 0);

  const bindBlocked = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "bind", instance, session, configHash], { store, streams: bindBlocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(bindBlocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(bindCalls().length, 0);

  const bound = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "bind", instance, session, configHash, "--yes"], { store, streams: bound.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(bound.stdout(), /bound to AI session/);
  assert.equal(bindCalls().length, 1);
  assert.deepEqual(bindCalls()[0].body, { configHash });

  const unbindDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "unbind", instance, session, configHash, "--dry-run"], { store, streams: unbindDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const unbindPlan = JSON.parse(unbindDryRun.stdout());
  assert.equal(unbindPlan.dryRun, true);
  assert.equal(unbindPlan.method, "DELETE");
  assert.equal(unbindPlan.path, unbindPath);
  assert.equal("body" in unbindPlan, false);
  assert.equal(unbindCalls().length, 0);

  const unbindBlocked = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "unbind", instance, session, configHash], { store, streams: unbindBlocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(unbindBlocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(unbindCalls().length, 0);

  const unbound = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "unbind", instance, session, configHash, "--yes"], { store, streams: unbound.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(unbound.stdout(), /unbound from AI session/);
  assert.equal(unbindCalls().length, 1);
});

test("trigger apply posts one deduplicated fan-out with an explicit enabled flag", async () => {
  const { store, fake } = await signedIn();
  const instance = "instance_fake001";
  const session = "ais_fake0000001";
  const configHash = "trg_fake000000000000000001";
  const applyPath = `/api/triggers/${configHash}/apply`;
  const applyCalls = () => fake.state.calls.filter((call) => call.method === "POST" && call.path === applyPath);
  const expectedBody = {
    instanceIds: [instance],
    target: { type: "ai-session", aiSessionId: session },
    enabled: true,
  };

  const dryRun = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--instance", instance, "--instance", instance, "--session", session, "--dry-run"], { store, streams: dryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.dryRun, true);
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, applyPath);
  assert.deepEqual(plan.body, expectedBody);
  assert.equal(applyCalls().length, 0);

  const disabled = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--instance", instance, "--session", session, "--disabled", "--dry-run"], { store, streams: disabled.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.equal(JSON.parse(disabled.stdout()).body.enabled, false);

  const blocked = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--instance", instance, "--session", session], { store, streams: blocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(applyCalls().length, 0);

  const applied = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--instance", instance, "--session", session, "--yes"], { store, streams: applied.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0);
  assert.match(applied.stdout(), /applied to 1 instance/);
  assert.equal(applyCalls().length, 1);
  assert.deepEqual(applyCalls()[0].body, expectedBody);

  const missingSession = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--instance", instance, "--yes"], { store, streams: missingSession.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(missingSession.stderr(), /CLI_OPTION_MISSING/);

  const missingInstance = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "apply", configHash, "--session", session, "--yes"], { store, streams: missingInstance.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(missingInstance.stderr(), /CLI_OPTION_MISSING/);

  const missingArgs = capture();
  assert.equal(await runCli(["node", "thctl", "trigger", "bind", instance], { store, streams: missingArgs.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(missingArgs.stderr(), /CLI_USAGE_ERROR/);

  assert.equal(applyCalls().length, 1);
});

test("app-session rename, access and restart drive the shared client behind the write gate", async () => {
  const { store, fake } = await signedIn();

  // rename：缺失/超长 title 都是用法错误；确认后发送 trim 过的 wire body
  const renameMissingTitle = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "rename", "instance_fake001", "appsess_fake001", "--yes"], { store, streams: renameMissingTitle.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(renameMissingTitle.stderr(), /CLI_USAGE_ERROR/);

  const renameTooLong = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "rename", "instance_fake001", "appsess_fake001", "x".repeat(121), "--yes"], { store, streams: renameTooLong.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(renameTooLong.stderr(), /CLI_INVALID_INPUT/);

  const renameDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "rename", "instance_fake001", "appsess_fake001", "  New title  ", "--dry-run"], { store, streams: renameDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, renameDryRun.stderr());
  const renamePlan = JSON.parse(renameDryRun.stdout());
  assert.equal(renamePlan.method, "PATCH");
  assert.equal(renamePlan.path, "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fake001");
  assert.deepEqual(renamePlan.body, { title: "New title" });

  const renameBlocked = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "rename", "instance_fake001", "appsess_fake001", "New title"], { store, streams: renameBlocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(renameBlocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);

  const renamed = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "rename", "instance_fake001", "appsess_fake001", "New title", "--yes", "--json"], { store, streams: renamed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, renamed.stderr());
  assert.equal(JSON.parse(renamed.stdout()).title, "New title");
  const renameCall = fake.state.calls.find((call) => call.method === "PATCH" && call.path === "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fake001");
  assert.deepEqual(renameCall.body, { title: "New title" });

  // access：dry-run 只描述 POST；tty 会话按服务端现状 409（退出码 8）；gui 会话拿到可打开的 VNC 租约
  const accessDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "access", "instance_fake001", "appsess_fakegui1", "--dry-run"], { store, streams: accessDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, accessDryRun.stderr());
  const accessPlan = JSON.parse(accessDryRun.stdout());
  assert.equal(accessPlan.method, "POST");
  assert.equal(accessPlan.path, "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fakegui1/access");
  assert.deepEqual(accessPlan.body, {});

  const accessUnavailable = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "access", "instance_fake001", "appsess_fake001", "--yes"], { store, streams: accessUnavailable.streams, fetchImpl: fake.fetchImpl, isTty: false }), 8);
  assert.match(accessUnavailable.stderr(), /APP_SESSION_ACCESS_UNAVAILABLE/);

  const accessTable = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "access", "instance_fake001", "appsess_fakegui1", "--yes"], { store, streams: accessTable.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, accessTable.stderr());
  assert.match(accessTable.stdout(), /vnc\s+http:\/\/cp\.test\/apps\/access\/vnc\?token=lease_fake\s+\S+\s+lease_fake/);

  const accessJson = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "access", "instance_fake001", "appsess_fakegui1", "--yes", "--json"], { store, streams: accessJson.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, accessJson.stderr());
  const lease = JSON.parse(accessJson.stdout());
  assert.equal(lease.mode, "vnc");
  assert.equal(lease.token, "lease_fake");
  assert.equal(lease.url, "/apps/access/vnc?token=lease_fake");

  // restart：dry-run 后确认；响应是新 session ID，CLI 不能回显旧 ID
  const restartDryRun = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "restart", "instance_fake001", "appsess_fake001", "--dry-run"], { store, streams: restartDryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, restartDryRun.stderr());
  const restartPlan = JSON.parse(restartDryRun.stdout());
  assert.equal(restartPlan.method, "POST");
  assert.equal(restartPlan.path, "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fake001/restart");
  assert.deepEqual(restartPlan.body, {});

  const restarted = capture();
  assert.equal(await runCli(["node", "thctl", "app-session", "restart", "instance_fake001", "appsess_fake001", "--yes", "--json"], { store, streams: restarted.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, restarted.stderr());
  assert.equal(JSON.parse(restarted.stdout()).id, "appsess_restarted1");
  const restartCall = fake.state.calls.find((call) => call.method === "POST" && call.path.endsWith("/restart"));
  assert.equal(restartCall.path, "/api/controlled-instances/instance_fake001/apps/sessions/appsess_fake001/restart");
  assert.deepEqual(restartCall.body, {});
});

test("story automation create, update and remove follow the declared wire routes", async () => {
  const { store, fake } = await signedIn();
  const directory = path.dirname(store.file);
  const createFile = path.join(directory, "automation-create.json");
  fs.writeFileSync(createFile, JSON.stringify({
    actionId: "action_fake0001",
    schedule: { scheduleKind: "interval", intervalMs: 3_600_000 },
    enabled: true,
  }));
  const updateFile = path.join(directory, "automation-update.json");
  fs.writeFileSync(updateFile, JSON.stringify({
    schedule: { scheduleKind: "daily", timeOfDay: "09:30", timezone: "Asia/Shanghai" },
    enabled: false,
  }));

  const missingConfig = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "create", "story_fake000001", "--yes"], { store, streams: missingConfig.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(missingConfig.stderr(), /CLI_OPTION_MISSING/);

  const redundantStoryId = path.join(directory, "automation-redundant-story.json");
  fs.writeFileSync(redundantStoryId, JSON.stringify({ storyId: "story_fake000001", actionId: "action_fake0001", schedule: { scheduleKind: "interval", intervalMs: 3_600_000 } }));
  const strictConfig = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "create", "story_fake000001", "--config", redundantStoryId, "--yes"], { store, streams: strictConfig.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(strictConfig.stderr(), /CLI_INVALID_INPUT/);

  const emptyUpdate = path.join(directory, "automation-empty-update.json");
  fs.writeFileSync(emptyUpdate, JSON.stringify({}));
  const emptyConfig = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "update", "story_fake000001", "auto_fake000001", "--config", emptyUpdate, "--yes"], { store, streams: emptyConfig.streams, fetchImpl: fake.fetchImpl, isTty: false }), 2);
  assert.match(emptyConfig.stderr(), /CLI_INVALID_INPUT/);

  const blocked = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "create", "story_fake000001", "--config", createFile], { store, streams: blocked.streams, fetchImpl: fake.fetchImpl, isTty: false }), 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);

  const dryRun = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "create", "story_fake000001", "--config", createFile, "--dry-run"], { store, streams: dryRun.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, dryRun.stderr());
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.dryRun, true);
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, "/api/stories/story_fake000001/automations");
  assert.equal(plan.body.nodeId, "node_fake0000001");
  assert.deepEqual(plan.body.input, {
    storyId: "story_fake000001",
    actionId: "action_fake0001",
    schedule: { scheduleKind: "interval", intervalMs: 3_600_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path === "/api/stories/story_fake000001/automations").length, 0);

  const created = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "create", "story_fake000001", "--config", createFile, "--yes", "--json"], { store, streams: created.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, created.stderr());
  const createdStatus = JSON.parse(created.stdout());
  assert.equal(createdStatus.automation.actionId, "action_fake0001");
  assert.equal(createdStatus.automation.schedule.intervalMs, 3_600_000);
  assert.equal(createdStatus.effectiveStatus, "scheduled");

  const updated = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "update", "story_fake000001", "auto_fake000001", "--config", updateFile, "--yes", "--json"], { store, streams: updated.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, updated.stderr());
  const updateCall = fake.state.calls.find((call) => call.method === "PATCH" && call.path === "/api/stories/story_fake000001/automations/auto_fake000001");
  assert.deepEqual(updateCall.body, { nodeId: "node_fake0000001", input: { schedule: { scheduleKind: "daily", timeOfDay: "09:30", timezone: "Asia/Shanghai" }, enabled: false } });
  assert.equal(JSON.parse(updated.stdout()).automation.enabled, false);

  const removed = capture();
  assert.equal(await runCli(["node", "thctl", "story", "automation", "remove", "story_fake000001", "auto_fake000001", "--yes", "--json"], { store, streams: removed.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, removed.stderr());
  assert.deepEqual(JSON.parse(removed.stdout()), { deleted: true });
  const removeCall = fake.state.calls.find((call) => call.method === "DELETE" && call.path === "/api/stories/story_fake000001/automations/auto_fake000001");
  assert.equal(removeCall.search, "?nodeId=node_fake0000001");
});
