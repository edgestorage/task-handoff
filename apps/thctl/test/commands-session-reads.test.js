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
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-session-reads-")));
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

function run(fake, store, argv, options = {}) {
  const output = capture();
  return runCli(["node", "thctl", ...argv], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, ...options })
    .then((code) => ({ code, ...output }));
}

test("app-session logs reads the instance log tail", async () => {
  const { store, fake } = await signedIn();
  const listed = await run(fake, store, ["app-session", "logs", "instance_fake001", "appsess_fakegui1", "--max-bytes", "2048", "--json"]);
  assert.equal(listed.code, 0, listed.stderr());
  const logs = JSON.parse(listed.stdout());
  assert.equal(logs.sessionId, "appsess_fakegui1");
  assert.equal(logs.maxBytes, 2048);
  assert.equal(logs.files[0].name, "session.log");
  const call = fake.state.calls.find((entry) => entry.path.endsWith("/logs"));
  assert.equal(call?.search, "?maxBytes=2048");

  const text = await run(fake, store, ["app-session", "logs", "instance_fake001", "appsess_fakegui1"]);
  assert.equal(text.code, 0, text.stderr());
  assert.match(text.stdout(), /==> session\.log <==/);
  assert.match(text.stdout(), /fake log line 2/);

  const invalid = await run(fake, store, ["app-session", "logs", "instance_fake001", "appsess_fakegui1", "--max-bytes", "0"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr(), /CLI_INVALID_OPTION/);
});

test("app-session screenshot saves the PNG and surfaces unavailable GUI sessions", async () => {
  const { store, fake } = await signedIn();
  const target = path.join(store.directory, "shot.png");
  const saved = await run(fake, store, ["app-session", "screenshot", "instance_fake001", "appsess_fakegui1", "--out", target, "--json"]);
  assert.equal(saved.code, 0, saved.stderr());
  const result = JSON.parse(saved.stdout());
  assert.equal(result.path, target);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.size, 16);
  assert.equal(fs.readFileSync(target).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  const unavailable = await run(fake, store, ["app-session", "screenshot", "instance_fake001", "appsess_fake001", "--out", target]);
  assert.equal(unavailable.code, 8);
  assert.match(unavailable.stderr(), /APP_SCREENSHOT_UNAVAILABLE/);
});

test("ai-session transcript prints the tail and keeps the wire model with --json", async () => {
  const { store, fake } = await signedIn();
  const text = await run(fake, store, ["ai-session", "transcript", "instance_fake001", "ais_fake0000001"]);
  assert.equal(text.code, 0, text.stderr());
  assert.match(text.stdout(), /fake transcript line 2/);
  assert.match(text.stdout(), /42 line\(s\)/);

  const full = await run(fake, store, ["ai-session", "transcript", "instance_fake001", "ais_fake0000001", "--tail", "5", "--json"]);
  assert.equal(full.code, 0, full.stderr());
  assert.equal(JSON.parse(full.stdout()).lineCount, 42);
  const call = fake.state.calls.filter((entry) => entry.path.endsWith("/transcript")).at(-1);
  assert.equal(call?.search, "?tail=5");
});

test("ai-session story-content lists documents and reads one document", async () => {
  const { store, fake } = await signedIn();
  const listed = await run(fake, store, ["ai-session", "story-content", "instance_fake001", "ais_fake0000001", "--json"]);
  assert.equal(listed.code, 0, listed.stderr());
  const content = JSON.parse(listed.stdout());
  assert.equal(content.storyId, "story_fake000001");
  assert.equal(content.documents[0].storyPath, "intro.md");

  const read = await run(fake, store, ["ai-session", "story-content", "read", "instance_fake001", "ais_fake0000001", "--path", "intro.md", "--json"]);
  assert.equal(read.code, 0, read.stderr());
  const preview = JSON.parse(read.stdout());
  assert.equal(preview.storyPath, "intro.md");
  assert.match(preview.content, /Fake story/);

  const text = await run(fake, store, ["ai-session", "story-content", "read", "instance_fake001", "ais_fake0000001", "--path", "intro.md"]);
  assert.equal(text.code, 0, text.stderr());
  assert.match(text.stdout(), /Body text\./);

  const missing = await run(fake, store, ["ai-session", "story-content", "read", "instance_fake001", "ais_fake0000001"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr(), /CLI_OPTION_MISSING/);
});

test("instance app catalog reads the catalog and replaces the custom catalog", async () => {
  const { store, fake } = await signedIn();
  const catalog = await run(fake, store, ["instance", "app", "catalog", "instance_fake001", "--json"]);
  assert.equal(catalog.code, 0, catalog.stderr());
  assert.deepEqual(JSON.parse(catalog.stdout()).items.map((item) => item.id), ["codex", "chromium"]);

  const custom = await run(fake, store, ["instance", "app", "catalog", "custom", "instance_fake001", "--json"]);
  assert.equal(custom.code, 0, custom.stderr());
  assert.equal(JSON.parse(custom.stdout()).items[0].id, "notepad");

  const configPath = path.join(store.directory, "custom-apps.json");
  fs.writeFileSync(configPath, JSON.stringify({ items: [{ id: "calc", name: "Calculator", kind: "gui", command: "calc" }] }));
  const dryRun = await run(fake, store, ["instance", "app", "catalog", "custom", "update", "instance_fake001", "--config", configPath, "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr());
  assert.equal(fake.state.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/catalog/custom")), false);

  const updated = await run(fake, store, ["instance", "app", "catalog", "custom", "update", "instance_fake001", "--config", configPath, "--yes", "--json"]);
  assert.equal(updated.code, 0, updated.stderr());
  assert.equal(JSON.parse(updated.stdout()).items[0].id, "calc");
  const patch = fake.state.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/catalog/custom")).at(-1);
  assert.deepEqual(patch?.body, { items: [{ id: "calc", name: "Calculator", kind: "gui", command: "calc" }] });
});

test("instance app job --logs appends the job log tail", async () => {
  const { store, fake } = await signedIn();
  const installed = await run(fake, store, ["instance", "app", "install", "instance_fake001", "codex", "--yes", "--json"]);
  assert.equal(installed.code, 0, installed.stderr());
  const jobId = JSON.parse(installed.stdout()).id;

  const waited = await run(fake, store, ["instance", "app", "job", "instance_fake001", jobId, "--wait", "--logs"], { sleep: async () => {} });
  assert.equal(waited.code, 0, waited.stderr());
  assert.match(waited.stdout(), /install finished/);
});
