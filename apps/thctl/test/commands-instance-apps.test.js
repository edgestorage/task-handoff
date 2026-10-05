import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-instance-apps-")));
}

async function signedIn(options = {}) {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://cp.test", ...options });
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

function run(fake, store, argv, options = {}) {
  const output = capture();
  return runCli(["node", "thctl", ...argv], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, ...options })
    .then((code) => ({ code, ...output }));
}

async function withStdin(text, execute) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([text]), configurable: true });
  try {
    return await execute();
  } finally {
    Object.defineProperty(process, "stdin", descriptor);
  }
}

test("app-session revoke-access reads the lease token from stdin and never leaks it", async () => {
  const { store, fake } = await signedIn();
  const missingStdin = await run(fake, store, ["app-session", "revoke-access", "instance_fake001", "appsess_fakegui1", "--yes"]);
  assert.equal(missingStdin.code, 2);
  assert.match(missingStdin.stderr(), /CLI_TOKEN_STDIN_REQUIRED/);
  assert.equal(fake.state.calls.filter((call) => call.method === "DELETE").length, 0);

  const revoked = await withStdin("lease_fake", () => run(fake, store, [
    "app-session", "revoke-access", "instance_fake001", "appsess_fakegui1", "--token-stdin", "--yes", "--json",
  ]));
  assert.equal(revoked.code, 0, revoked.stderr());
  assert.equal(JSON.parse(revoked.stdout()).revoked, true);
  const call = fake.state.calls.find((entry) => entry.method === "DELETE" && entry.path.endsWith("/access"));
  assert.deepEqual(call?.body, { token: "lease_fake" });
});

test("ai-session workspace and checkout drive the shared workspace routes", async () => {
  const { store, fake } = await signedIn();
  const workspace = await run(fake, store, ["ai-session", "workspace", "instance_fake001", "--json"]);
  assert.equal(workspace.code, 0, workspace.stderr());
  assert.equal(JSON.parse(workspace.stdout()).currentBranch, "main");
  assert.equal(fake.state.calls.some((call) => call.method === "GET" && call.path === "/api/controlled-instances/instance_fake001/ai-sessions/workspace"), true);

  const missingBranch = await run(fake, store, ["ai-session", "checkout", "instance_fake001", "--yes"]);
  assert.equal(missingBranch.code, 2);
  assert.match(missingBranch.stderr(), /CLI_OPTION_MISSING/);

  const checkedOut = await run(fake, store, ["ai-session", "checkout", "instance_fake001", "--branch", "feature/demo", "--yes", "--json"]);
  assert.equal(checkedOut.code, 0, checkedOut.stderr());
  assert.equal(JSON.parse(checkedOut.stdout()).currentBranch, "feature/demo");
  assert.deepEqual(fake.state.calls.find((call) => call.path.endsWith("/workspace/checkout"))?.body, { branch: "feature/demo" });
});

test("instance update sends the settings body from --config", async () => {
  const { store, fake } = await signedIn();
  const configPath = path.join(store.directory, "instance-update.json");
  const input = {
    config: { defaultCodexPermissionMode: "auto-review", aiSessionHistoryLimit: 25 },
    modelSelection: { modelEntityIds: ["model_fake00001"] },
  };
  fs.writeFileSync(configPath, JSON.stringify(input));

  const dryRun = await run(fake, store, ["instance", "update", "instance_fake001", "--config", configPath, "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr());
  assert.equal(fake.state.calls.some((call) => call.method === "PATCH"), false);
  assert.equal(JSON.parse(dryRun.stdout()).dryRun, true);

  const updated = await run(fake, store, ["instance", "update", "instance_fake001", "--config", configPath, "--yes", "--json"]);
  assert.equal(updated.code, 0, updated.stderr());
  const body = fake.state.calls.filter((call) => call.method === "PATCH").at(-1)?.body;
  assert.deepEqual(body, input);
  assert.equal(JSON.parse(updated.stdout()).config.defaultCodexPermissionMode, "auto-review");

  fs.writeFileSync(configPath, JSON.stringify({ config: { defaultCodexPermissionMode: "nope" } }));
  const invalid = await run(fake, store, ["instance", "update", "instance_fake001", "--config", configPath, "--yes"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr(), /CLI_INVALID_INPUT/);
});

test("instance app list, install and job follow the managed app surface", async () => {
  const { store, fake } = await signedIn();
  const listed = await run(fake, store, ["instance", "app", "list", "instance_fake001", "--json"]);
  assert.equal(listed.code, 0, listed.stderr());
  const snapshot = JSON.parse(listed.stdout());
  assert.deepEqual(snapshot.apps.map((app) => app.id), ["codex", "chromium"]);

  const installed = await run(fake, store, ["instance", "app", "install", "instance_fake001", "codex", "--yes", "--json"]);
  assert.equal(installed.code, 0, installed.stderr());
  const installCall = fake.state.calls.find((call) => call.path.endsWith("/apps/codex/install"));
  assert.match(installCall?.body.requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(installed.stdout()).state, "queued");

  const waited = await run(fake, store, ["instance", "app", "install", "instance_fake001", "codex", "--wait", "--yes", "--json"], { sleep: async () => {} });
  assert.equal(waited.code, 0, waited.stderr());
  assert.equal(JSON.parse(waited.stdout()).state, "succeeded");
  const polls = fake.state.calls.filter((call) => call.path.endsWith("/apps/jobs/appjob_install_01"));
  assert.ok(polls.length >= 2, `expected the wait poll to follow the job, saw ${polls.length}`);

  const job = await run(fake, store, ["instance", "app", "job", "instance_fake001", "appjob_install_01", "--json"]);
  assert.equal(job.code, 0, job.stderr());
  assert.equal(JSON.parse(job.stdout()).appId, "codex");

  const uninstalled = await run(fake, store, ["instance", "app", "uninstall", "instance_fake001", "chromium", "--yes", "--json"]);
  assert.equal(uninstalled.code, 0, uninstalled.stderr());
  assert.equal(JSON.parse(uninstalled.stdout()).operation, "uninstall");
});

test("app-profile commands manage browser profiles for an instance app", async () => {
  const { store, fake } = await signedIn();
  const listed = await run(fake, store, ["app-profile", "list", "instance_fake001", "chromium", "--json"]);
  assert.equal(listed.code, 0, listed.stderr());
  assert.equal(JSON.parse(listed.stdout()).profiles[0].name, "Default");

  const created = await run(fake, store, ["app-profile", "create", "instance_fake001", "chromium", "--name", "Work", "--yes", "--json"]);
  assert.equal(created.code, 0, created.stderr());
  assert.deepEqual(fake.state.calls.find((call) => call.method === "POST" && call.path.endsWith("/profiles"))?.body, { name: "Work" });

  const renamed = await run(fake, store, ["app-profile", "rename", "instance_fake001", "chromium", "appprof_new001", "--name", "Private", "--yes", "--json"]);
  assert.equal(renamed.code, 0, renamed.stderr());
  assert.equal(JSON.parse(renamed.stdout()).name, "Private");

  const defaulted = await run(fake, store, ["app-profile", "set-default", "instance_fake001", "chromium", "appprof_new001", "--yes", "--json"]);
  assert.equal(defaulted.code, 0, defaulted.stderr());
  assert.equal(JSON.parse(defaulted.stdout()).isDefault, true);

  const removed = await run(fake, store, ["app-profile", "remove", "instance_fake001", "chromium", "appprof_new001", "--yes", "--json"]);
  assert.equal(removed.code, 0, removed.stderr());
  assert.equal(JSON.parse(removed.stdout()).removed, true);
});
