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
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-stage-b-")));
}

async function signedIn() {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://cp.test" });
  const add = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", "http://cp.test"], { store, streams: add.streams, fetchImpl: fake.fetchImpl, isTty: false }), 0, add.stderr());
  const login = capture();
  let polls = 0;
  assert.equal(await runCli(["node", "thctl", "login", "--device"], {
    store,
    streams: login.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    sleep: async () => {
      polls += 1;
      if (polls >= 2) fake.state.deviceApproved = true;
    },
  }), 0, login.stderr());
  return { store, fake };
}

function run(fake, store, argv) {
  const output = capture();
  return runCli(["node", "thctl", ...argv], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, ...(argv.includes("--json") ? {} : {}) })
    .then((code) => ({ code, ...output }));
}

test("ai-session write commands drive the shared client behind the write gate", async () => {
  const { store, fake } = await signedIn();
  const created = await run(fake, store, ["ai-session", "create", "instance_fake001", "--agent", "codex", "--prompt", "hello", "--yes", "--json"]);
  assert.equal(created.code, 0, created.stderr());
  assert.equal(JSON.parse(created.stdout()).disposition, "created");
  assert.equal(fake.state.calls.some((call) => call.method === "POST" && call.path === "/api/controlled-instances/instance_fake001/ai-sessions"), true);

  const sent = await run(fake, store, ["ai-session", "send", "instance_fake001", "ais_fake0000001", "ping", "--yes", "--json"]);
  assert.equal(sent.code, 0, sent.stderr());
  const sendBody = fake.state.calls.find((call) => call.path.endsWith("/messages"))?.body;
  assert.deepEqual(sendBody, { message: "ping", attachments: [], references: [] });

  const interrupt = await run(fake, store, ["ai-session", "interrupt", "instance_fake001", "ais_fake0000001", "--yes", "--json"]);
  assert.equal(interrupt.code, 0, interrupt.stderr());
  assert.equal(JSON.parse(interrupt.stdout()).action, "interrupt");

  const approval = await run(fake, store, ["ai-session", "approval", "instance_fake001", "ais_fake0000001", "--decision", "deny", "--yes", "--json"]);
  assert.equal(approval.code, 0, approval.stderr());
  assert.equal(JSON.parse(approval.stdout()).decision, "deny");

  const invalidApproval = await run(fake, store, ["ai-session", "approval", "instance_fake001", "ais_fake0000001", "--decision", "maybe", "--yes"]);
  assert.equal(invalidApproval.code, 2);
  assert.match(invalidApproval.stderr(), /CLI_INVALID_OPTION/);

  const resume = await run(fake, store, ["ai-session", "resume", "instance_fake001", "ais_fake0000001", "--yes", "--json"]);
  assert.equal(resume.code, 0, resume.stderr());
  assert.equal(JSON.parse(resume.stdout()).disposition, "resumed");

  const read = await run(fake, store, ["ai-session", "read", "instance_fake001", "ais_fake0000001", "--yes", "--json"]);
  assert.equal(read.code, 0, read.stderr());
  assert.equal(JSON.parse(read.stdout()).unread, false);

  const history = await run(fake, store, ["ai-session", "history", "instance_fake001", "--agent", "claude", "--agent", "codex", "--json"]);
  assert.equal(history.code, 0, history.stderr());
  assert.equal(JSON.parse(history.stdout()).items[0].agent, "claude");
  assert.match(fake.state.calls.find((call) => call.path.endsWith("/ai-sessions/history"))?.search ?? "", /agents=claude%2Ccodex/);
});

test("ai-session queue commands read the session projection and mutate through the gate", async () => {
  const { store, fake } = await signedIn();
  const list = await run(fake, store, ["ai-session", "queue", "list", "instance_fake001", "ais_fake0000001", "--json"]);
  assert.equal(list.code, 0, list.stderr());
  assert.equal(JSON.parse(list.stdout()).items[0].id, "queue_fake01");

  for (const [action, expectPath] of [["steer", "/steer"], ["retry", "/retry"]]) {
    const result = await run(fake, store, ["ai-session", "queue", action, "instance_fake001", "ais_fake0000001", "queue_fake01", "--yes", "--json"]);
    assert.equal(result.code, 0, `${action}: ${result.stderr()}`);
    assert.equal(fake.state.calls.some((call) => call.method === "POST" && call.path.endsWith(expectPath)), true);
  }
  const removed = await run(fake, store, ["ai-session", "queue", "remove", "instance_fake001", "ais_fake0000001", "queue_fake01", "--yes", "--json"]);
  assert.equal(removed.code, 0, removed.stderr());
  assert.equal(JSON.parse(removed.stdout()).action, "remove");
});

test("app-session commands consume the authoritative projection", async () => {
  const { store, fake } = await signedIn();
  const list = await run(fake, store, ["app-session", "list", "--json"]);
  assert.equal(list.code, 0, list.stderr());
  assert.equal(JSON.parse(list.stdout()).instances[0].appSessions.sessions[0].id, "appsess_fake001");

  const show = await run(fake, store, ["app-session", "show", "instance_fake001", "appsess_fake001", "--json"]);
  assert.equal(show.code, 0, show.stderr());
  assert.equal(JSON.parse(show.stdout()).status, "running");

  const started = await run(fake, store, ["app-session", "start", "instance_fake001", "app_fake01", "--yes", "--json"]);
  assert.equal(started.code, 0, started.stderr());
  assert.equal(JSON.parse(started.stdout()).status, "starting");

  const stopped = await run(fake, store, ["app-session", "stop", "instance_fake001", "appsess_fake001", "--yes", "--json"]);
  assert.equal(stopped.code, 0, stopped.stderr());
  assert.equal(JSON.parse(stopped.stdout()).status, "stopped");

  const missing = await run(fake, store, ["app-session", "show", "instance_fake001", "appsess_missing"]);
  assert.equal(missing.code, 7);
  assert.match(missing.stderr(), /CLI_APP_SESSION_NOT_FOUND/);
});

test("node commands read the fleet directory and rename through the gate", async () => {
  const { store, fake } = await signedIn();
  const list = await run(fake, store, ["node", "list", "--json"]);
  assert.equal(list.code, 0, list.stderr());
  assert.equal(JSON.parse(list.stdout())[0].id, "node_fake0000001");

  const show = await run(fake, store, ["node", "show", "node_fake0000001", "--json"]);
  assert.equal(show.code, 0, show.stderr());
  assert.equal(JSON.parse(show.stdout()).connectionMode, "reverse-wss");

  const missing = await run(fake, store, ["node", "show", "node_missing"]);
  assert.equal(missing.code, 7);
  assert.match(missing.stderr(), /CLI_NODE_NOT_FOUND/);

  const renamed = await run(fake, store, ["node", "rename", "node_fake0000001", "renamed-node", "--yes", "--json"]);
  assert.equal(renamed.code, 0, renamed.stderr());
  assert.equal(JSON.parse(renamed.stdout()).name, "renamed-node");
});

test("story commands resolve the owning node from the directory without caching", async () => {
  const { store, fake } = await signedIn();
  const list = await run(fake, store, ["story", "list", "--json"]);
  assert.equal(list.code, 0, list.stderr());
  assert.equal(JSON.parse(list.stdout()).stories[0].id, "story_fake000001");

  const show = await run(fake, store, ["story", "show", "story_fake000001", "--json"]);
  assert.equal(show.code, 0, show.stderr());
  assert.equal(JSON.parse(show.stdout()).ownerNodeId, "node_fake0000001");

  const created = await run(fake, store, ["story", "create", "New story", "--yes", "--json"]);
  assert.equal(created.code, 0, created.stderr());
  const createBody = fake.state.calls.find((call) => call.method === "POST" && call.path === "/api/stories")?.body;
  assert.equal(createBody.nodeId, "node_fake0000001");
  assert.equal(createBody.input.title, "New story");

  const updated = await run(fake, store, ["story", "update", "story_fake000001", "--title", "Renamed", "--yes", "--json"]);
  assert.equal(updated.code, 0, updated.stderr());

  const archived = await run(fake, store, ["story", "archive", "story_fake000001", "--yes", "--json"]);
  assert.equal(archived.code, 0, archived.stderr());
  const restored = await run(fake, store, ["story", "restore", "story_fake000001", "--yes", "--json"]);
  assert.equal(restored.code, 0, restored.stderr());
  const removed = await run(fake, store, ["story", "remove", "story_fake000001", "--yes", "--json"]);
  assert.equal(removed.code, 0, removed.stderr());
  assert.equal(JSON.parse(removed.stdout()).deleted, true);

  const documents = await run(fake, store, ["story", "document", "update", "story_fake000001", "intro.md", "--title", "Introduction", "--yes", "--json"]);
  assert.equal(documents.code, 0, documents.stderr());
  const reordered = await run(fake, store, ["story", "document", "reorder", "story_fake000001", "b.md", "a.md", "--yes", "--json"]);
  assert.equal(reordered.code, 0, reordered.stderr());
  assert.deepEqual(JSON.parse(reordered.stdout()).documents.map((document) => document.storyPath), ["b.md", "a.md"]);
  const documentRemoved = await run(fake, store, ["story", "document", "remove", "story_fake000001", "intro.md", "--yes", "--json"]);
  assert.equal(documentRemoved.code, 0, documentRemoved.stderr());

  const automations = await run(fake, store, ["story", "automation", "list", "story_fake000001", "--json"]);
  assert.equal(automations.code, 0, automations.stderr());
  assert.equal(JSON.parse(automations.stdout()).automations[0].automation.id, "auto_fake000001");
  const automation = await run(fake, store, ["story", "automation", "show", "story_fake000001", "auto_fake000001", "--json"]);
  assert.equal(automation.code, 0, automation.stderr());
  const disabled = await run(fake, store, ["story", "automation", "disable", "story_fake000001", "auto_fake000001", "--yes", "--json"]);
  assert.equal(disabled.code, 0, disabled.stderr());
  assert.equal(JSON.parse(disabled.stdout()).automation.enabled, false);
  const enabled = await run(fake, store, ["story", "automation", "enable", "story_fake000001", "auto_fake000001", "--yes", "--json"]);
  assert.equal(enabled.code, 0, enabled.stderr());
  const ran = await run(fake, store, ["story", "automation", "run", "story_fake000001", "auto_fake000001", "--yes", "--json"]);
  assert.equal(ran.code, 0, ran.stderr());
  assert.equal(JSON.parse(ran.stdout()).status, "queued");
  const runs = await run(fake, store, ["story", "automation", "runs", "story_fake000001", "auto_fake000001", "--json"]);
  assert.equal(runs.code, 0, runs.stderr());
  assert.equal(JSON.parse(runs.stdout()).runs.length, 1);
});

test("trigger commands create, bind, update, remove and run triggers", async () => {
  const { store, fake } = await signedIn();
  const list = await run(fake, store, ["trigger", "list", "--json"]);
  assert.equal(list.code, 0, list.stderr());
  assert.equal(JSON.parse(list.stdout()).triggers[0].configHash, "trg_fake000000000000000001");

  const filtered = await run(fake, store, ["trigger", "list", "--instance", "instance_other", "--json"]);
  assert.deepEqual(JSON.parse(filtered.stdout()).triggers, []);

  const show = await run(fake, store, ["trigger", "show", "trg_fake000000000000000001", "--json"]);
  assert.equal(show.code, 0, show.stderr());
  assert.equal(JSON.parse(show.stdout()).deployments[0].instanceId, "instance_fake001");

  const configFile = path.join(path.dirname(store.file), "trigger.json");
  fs.writeFileSync(configFile, JSON.stringify({ name: "Fake trigger", source: { type: "ai-session" }, action: { promptTemplate: "Run it." } }));

  const created = await run(fake, store, ["trigger", "create", "instance_fake001", "ais_fake0000001", "--config", configFile, "--yes", "--json"]);
  assert.equal(created.code, 0, created.stderr());
  const createdBody = JSON.parse(created.stdout());
  assert.equal(createdBody.trigger.configHash, "trg_fake000000000000000001");
  assert.equal(fake.state.calls.some((call) => call.path.endsWith("/ai-sessions/ais_fake0000001/triggers")), true);

  const updated = await run(fake, store, ["trigger", "update", "trg_fake000000000000000001", "--config", configFile, "--yes", "--json"]);
  assert.equal(updated.code, 0, updated.stderr());
  const removed = await run(fake, store, ["trigger", "remove", "trg_fake000000000000000001", "--yes", "--json"]);
  assert.equal(removed.code, 0, removed.stderr());
  const ran = await run(fake, store, ["trigger", "run", "instance_fake001", "trg_fake000000000000000001", "--yes", "--json"]);
  assert.equal(ran.code, 0, ran.stderr());
  assert.equal(JSON.parse(ran.stdout()).status, "queued");

  const invalidFile = path.join(path.dirname(store.file), "invalid-trigger.json");
  fs.writeFileSync(invalidFile, JSON.stringify({ name: "missing source" }));
  const invalid = await run(fake, store, ["trigger", "create", "instance_fake001", "ais_fake0000001", "--config", invalidFile, "--yes"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr(), /CLI_INVALID_INPUT/);
});

test("model and user commands read their authoritative projections", async () => {
  const { store, fake } = await signedIn();
  const models = await run(fake, store, ["model", "list", "--json"]);
  assert.equal(models.code, 0, models.stderr());
  assert.equal(JSON.parse(models.stdout()).models[0].id, "model_fake00001");
  const model = await run(fake, store, ["model", "show", "model_fake00001", "--json"]);
  assert.equal(model.code, 0, model.stderr());
  assert.equal(JSON.parse(model.stdout()).model.name, "Fake Model");
  const missingModel = await run(fake, store, ["model", "show", "model_missing"]);
  assert.equal(missingModel.code, 7);

  const users = await run(fake, store, ["user", "list", "--json"]);
  assert.equal(users.code, 0, users.stderr());
  assert.equal(JSON.parse(users.stdout())[0].id, "user_fake0000000");
  const user = await run(fake, store, ["user", "show", "user_fake0000000", "--json"]);
  assert.equal(user.code, 0, user.stderr());
  assert.equal(JSON.parse(user.stdout()).primaryUsername, "admin");
  const sessions = await run(fake, store, ["user", "sessions", "user_fake0000000", "--json"]);
  assert.equal(sessions.code, 0, sessions.stderr());
  assert.equal(JSON.parse(sessions.stdout())[0].clientType, "web");
  const revoked = await run(fake, store, ["user", "session-revoke", "user_fake0000000", "usess_fake0001", "--yes", "--json"]);
  assert.equal(revoked.code, 0, revoked.stderr());
  assert.equal(JSON.parse(revoked.stdout()).revoked, true);
});

test("stage B writes keep the confirmation gate and dry-run stays local", async () => {
  const { store, fake } = await signedIn();
  const before = fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/interrupt")).length;

  const blocked = await run(fake, store, ["ai-session", "interrupt", "instance_fake001", "ais_fake0000001"]);
  assert.equal(blocked.code, 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/interrupt")).length, before);

  const dryRun = await run(fake, store, ["ai-session", "interrupt", "instance_fake001", "ais_fake0000001", "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr());
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.dryRun, true);
  assert.equal(plan.path, "/api/controlled-instances/instance_fake001/ai-sessions/ais_fake0000001/interrupt");
  assert.equal(fake.state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/interrupt")).length, before);

  const multiStep = await run(fake, store, ["trigger", "create", "instance_fake001", "ais_fake0000001", "--config", writeTriggerFile(store), "--dry-run"]);
  assert.equal(multiStep.code, 0, multiStep.stderr());
  assert.equal(JSON.parse(multiStep.stdout()).steps.length, 2);
});

test("instance create and delete drive the shared client behind the write gate", async () => {
  const { store, fake } = await signedIn();
  const configFile = path.join(path.dirname(store.file), "instance-create.json");
  fs.writeFileSync(configFile, JSON.stringify({
    nodeId: "node_fake0000001",
    runtimeId: "runtime_local_docker",
    source: { type: "local-folder", path: "/workspace/fake" },
    imageSelection: { imageId: "img_fake0001" },
    start: true,
  }));

  const blocked = await run(fake, store, ["instance", "create", "--config", configFile]);
  assert.equal(blocked.code, 4);
  assert.match(blocked.stderr(), /CLI_CONFIRMATION_REQUIRED/);

  const dryRun = await run(fake, store, ["instance", "create", "--config", configFile, "--name", "override-name", "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr());
  const plan = JSON.parse(dryRun.stdout());
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, "/api/controlled-instances");
  assert.equal(plan.body.name, "override-name");
  assert.equal(plan.body.start, true);

  const created = await run(fake, store, ["instance", "create", "--config", configFile, "--yes", "--json"]);
  assert.equal(created.code, 0, created.stderr());
  const record = JSON.parse(created.stdout());
  assert.equal(record.id, "inst_created0001");
  assert.equal(record.startOutcome.status, "started");
  assert.equal(record.registrationToken, undefined);
  const createCall = fake.state.calls.find((call) => call.method === "POST" && call.path === "/api/controlled-instances");
  assert.equal(createCall?.body.start, true);
  assert.equal(createCall?.headers["content-type"], "application/json");

  const invalidJson = path.join(path.dirname(store.file), "instance-invalid.json");
  fs.writeFileSync(invalidJson, "{not json");
  const badFile = await run(fake, store, ["instance", "create", "--config", invalidJson, "--yes"]);
  assert.equal(badFile.code, 2);
  assert.match(badFile.stderr(), /CLI_FILE_INVALID_JSON/);

  const blockedDelete = await run(fake, store, ["instance", "delete", "instance_fake001"]);
  assert.equal(blockedDelete.code, 4);

  const deleteDryRun = await run(fake, store, ["instance", "delete", "instance_fake001", "--volumes", "--dry-run"]);
  assert.equal(deleteDryRun.code, 0, deleteDryRun.stderr());
  const deletePlan = JSON.parse(deleteDryRun.stdout());
  assert.equal(deletePlan.method, "DELETE");
  assert.deepEqual(deletePlan.body, { deleteVolumes: true });

  const deleted = await run(fake, store, ["instance", "delete", "instance_fake001", "--yes", "--json"]);
  assert.equal(deleted.code, 0, deleted.stderr());
  assert.equal(JSON.parse(deleted.stdout()).completed, true);
  const deleteCall = fake.state.calls.find((call) => call.method === "DELETE" && call.path === "/api/controlled-instances/instance_fake001");
  assert.deepEqual(deleteCall?.body, { deleteVolumes: false });
  assert.equal(deleteCall?.headers["content-type"], "application/json");

  fake.state.deleteIncomplete = true;
  const incomplete = await run(fake, store, ["instance", "delete", "instance_fake002", "--yes", "--json"]);
  assert.equal(incomplete.code, 8);
  const incompleteError = JSON.parse(incomplete.stderr()).error;
  assert.equal(incompleteError.code, "CLI_INSTANCE_DELETE_INCOMPLETE");
  assert.equal(incompleteError.details.volumeResults[0].status, "failed");
});

test("stage C commands that are still planned stay declared but unimplemented", async () => {
  const { store, fake } = await signedIn();
  const logs = await run(fake, store, ["instance", "logs", "instance_fake001"]);
  assert.equal(logs.code, 3);
  assert.match(logs.stderr(), /CLI_COMMAND_NOT_IMPLEMENTED/);
  assert.equal(fake.state.calls.some((call) => call.path.endsWith("/logs")), false);

  const schema = await run(fake, store, ["schema", "trigger", "create", "--json"]);
  assert.equal(schema.code, 0, schema.stderr());
  assert.equal(JSON.parse(schema.stdout()).commands[0].id, "trigger create");
});

function writeTriggerFile(store) {
  const configFile = path.join(path.dirname(store.file), "trigger-dry-run.json");
  fs.writeFileSync(configFile, JSON.stringify({ name: "Fake trigger", source: { type: "ai-session" }, action: { promptTemplate: "Run it." } }));
  return configFile;
}
