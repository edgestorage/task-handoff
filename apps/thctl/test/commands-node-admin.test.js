import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

const NODE_ID = "node_fake0000001";
const now = new Date().toISOString();

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempStore() {
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-node-admin-")));
}

async function signedIn(options = {}) {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://cp.test" });
  await runCli(["node", "thctl", "profile", "add", "http://cp.test"], { store, streams: capture().streams, fetchImpl: fake.fetchImpl, isTty: false });
  let polls = 0;
  const output = capture();
  const code = await runCli(["node", "thctl", "login", "--device"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    sleep: async () => {
      polls += 1;
      if (polls >= 2) fake.state.deviceApproved = true;
    },
  });
  assert.equal(code, 0, output.stderr());
  return { store, fake };
}

const folder = {
  id: "folder_fake0001", nodeId: NODE_ID, name: "workspace", path: "/home/agent/workspace",
  labels: {}, createdAt: now, updatedAt: now,
};
const runtime = {
  id: "runtime_fake01", nodeId: NODE_ID, name: "docker", type: "docker", status: "online",
  accessStrategy: "node-proxy", capabilities: {}, labels: {}, createdAt: now, updatedAt: now,
};

/** 包装 fake CP，补充 node 管理面路由；`routeMissing` 用来模拟旧服务端未注册路由。 */
function nodeAdminFetch(fake, options = {}) {
  const capabilities = options.capabilities ?? { folderPlaces: true, localFolderNameUpdate: true, managedModels: { modelRelay: { protocols: ["openai-chat-completions"] } } };
  const nodeRecord = { id: NODE_ID, name: "fake-node", status: "online", health: "ok", connectionMode: "reverse-wss", observedAt: now, capabilities: ["managedModels"], auth: { mode: "local-static-key", secret: "should-not-leak" } };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const { pathname } = parsed;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: pathname, search: parsed.search, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (options.routeMissing?.({ method, path: pathname })) {
      return new Response(JSON.stringify({ message: `Route ${method}:${pathname} not found`, error: "Not Found", statusCode: 404 }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}`) {
      return json(200, { data: { ...nodeRecord, capabilities: { agent: { capabilities } } } });
    }
    if (method === "GET" && pathname === "/api/nodes") return json(200, { data: [{ id: NODE_ID, name: "fake-node", status: "online", health: "ok", connectionMode: "reverse-wss", observedAt: now, capabilities: ["managedModels"] }] });
    if (method === "POST" && pathname === `/api/nodes/${NODE_ID}/check`) return json(200, { data: { id: NODE_ID, status: "online", checkedAt: now } });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/local-folders`) return json(200, { data: [folder] });
    if (method === "POST" && pathname === `/api/nodes/${NODE_ID}/local-folders`) return json(201, { data: { ...folder, id: "folder_new00001", name: body?.name ?? "new" } });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/runtimes`) return json(200, { data: [runtime] });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/docker/images`) return json(200, { data: [{ id: "sha256:abc", reference: "ghcr.io/x/y:1", repoDigests: [], sizeBytes: 1024 }] });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/image-options`) return json(200, { data: [] });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/settings/model-relay`) return json(200, { data: { enabled: true, source: "persisted" } });
    if (method === "PATCH" && pathname === `/api/nodes/${NODE_ID}/settings/model-relay`) return json(200, { data: { enabled: body?.enabled === true, source: "persisted" } });
    if (method === "GET" && pathname === `/api/nodes/${NODE_ID}/updates/jobs`) return json(200, { data: [] });
    if (method === "POST" && pathname === "/api/node-join/complete") return json(201, { data: { id: "node_joined0001", name: "joined", status: "online", health: "ok", connectionMode: "reverse-wss", observedAt: now, capabilities: [], auth: { mode: "local-static-key" } } });
    return fake.fetchImpl(url, init);
  };
  return { fetchImpl, calls };
}

function writeConfig(store, value) {
  const file = path.join(store.directory, "body.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("node read commands render tables and JSON from the shared client", async () => {
  const { store, fake } = await signedIn();
  const admin = nodeAdminFetch(fake);
  const folders = capture();
  assert.equal(await runCli(["node", "thctl", "node", "folders", "list", NODE_ID], { store, streams: folders.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, folders.stderr());
  assert.match(folders.stdout(), /workspace/);
  assert.match(folders.stdout(), /\/home\/agent\/workspace/);

  const runtimes = capture();
  assert.equal(await runCli(["node", "thctl", "node", "runtimes", "list", NODE_ID, "--json"], { store, streams: runtimes.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, runtimes.stderr());
  assert.equal(JSON.parse(runtimes.stdout())[0].id, runtime.id);

  const relay = capture();
  assert.equal(await runCli(["node", "thctl", "node", "settings", "model-relay", "show", NODE_ID], { store, streams: relay.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, relay.stderr());
  assert.match(relay.stdout(), /persisted/);

  const jobs = capture();
  assert.equal(await runCli(["node", "thctl", "node", "updates", "jobs", NODE_ID], { store, streams: jobs.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, jobs.stderr());
  assert.match(jobs.stdout(), /No update jobs matched/);
});

test("node writes require confirmation and never mark the response auth secret", async () => {
  const { store, fake } = await signedIn();
  const admin = nodeAdminFetch(fake);
  const config = writeConfig(store, { name: "projects", path: "/home/agent/projects" });
  const refused = capture();
  assert.equal(await runCli(["node", "thctl", "node", "folders", "add", NODE_ID, "--config", config], { store, streams: refused.streams, fetchImpl: admin.fetchImpl, isTty: false }), 4, refused.stderr());
  assert.match(refused.stderr(), /CLI_CONFIRMATION_REQUIRED/);
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.path.endsWith("/local-folders")), false, "non-TTY without --yes must not send the request");

  const confirmed = capture();
  assert.equal(await runCli(["node", "thctl", "node", "folders", "add", NODE_ID, "--config", config, "--yes"], { store, streams: confirmed.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, confirmed.stderr());
  assert.ok(admin.calls.some((call) => call.method === "POST" && call.path.endsWith("/local-folders")));
});

test("node capability gaps close only the gated domain", async () => {
  const { store, fake } = await signedIn();
  const admin = nodeAdminFetch(fake, { capabilities: { managedModels: { modelRelay: { protocols: [] } } } });
  const config = writeConfig(store, { name: "projects", path: "/home/agent/projects" });
  const folderWrite = capture();
  assert.equal(await runCli(["node", "thctl", "node", "folders", "add", NODE_ID, "--config", config, "--yes"], { store, streams: folderWrite.streams, fetchImpl: admin.fetchImpl, isTty: false }), 14, folderWrite.stderr());
  assert.match(folderWrite.stderr(), /CLI_CAPABILITY_MISSING/);
  assert.match(folderWrite.stderr(), /localFolderPlaces/);

  const relayWrite = capture();
  const relayConfig = writeConfig(store, { enabled: true });
  assert.equal(await runCli(["node", "thctl", "node", "settings", "model-relay", "set", NODE_ID, "--config", relayConfig, "--yes"], { store, streams: relayWrite.streams, fetchImpl: admin.fetchImpl, isTty: false }), 14, relayWrite.stderr());
  assert.match(relayWrite.stderr(), /modelRelay/);

  const stillReads = capture();
  assert.equal(await runCli(["node", "thctl", "node", "folders", "list", NODE_ID], { store, streams: stillReads.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, stillReads.stderr());
  assert.match(stillReads.stdout(), /workspace/);
});

test("unregistered routes on an older server normalize to capability missing", async () => {
  const { store, fake } = await signedIn();
  const admin = nodeAdminFetch(fake, { routeMissing: ({ path: routePath }) => routePath.endsWith("/image-options") });
  const output = capture();
  const code = await runCli(["node", "thctl", "node", "image-options", NODE_ID], { store, streams: output.streams, fetchImpl: admin.fetchImpl, isTty: false });
  assert.equal(code, 14);
  assert.match(output.stderr(), /CLI_CAPABILITY_MISSING/);
  assert.match(output.stderr(), /node image-options/);
});

test("dry-run and errors redact secrets read from config files", async () => {
  const { store, fake } = await signedIn();
  const admin = nodeAdminFetch(fake);
  const config = writeConfig(store, {
    joinToken: "join-token-super-secret-value",
    nodeId: "node_joined0001",
    keyId: "key_fake00000001",
    secret: "paired-secret-super-secret-value",
  });
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "node-join", "complete", "--config", config, "--dry-run"], { store, streams: output.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, output.stderr());
  assert.doesNotMatch(output.stdout(), /super-secret-value/);
  assert.match(output.stdout(), /\*\*\*/);
  assert.equal(admin.calls.some((call) => call.path === "/api/node-join/complete"), false, "dry-run must not send the request");
});

test("schema export documents the secret input channel without secret defaults", async () => {
  const store = tempStore();
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "schema"], { store, streams: output.streams, isTty: false }), 0, output.stderr());
  const document = JSON.parse(output.stdout());
  assert.ok(document.globalOptions.some((option) => option.flags === "--token-stdin"));
  const serialized = JSON.stringify(document.commands);
  assert.doesNotMatch(serialized, /super-secret/);
  for (const command of document.commands) {
    assert.equal(command.inputSchema.default === undefined, true);
    const required = command.inputSchema.required ?? [];
    assert.equal(required.includes("token"), false, `${command.id} must not accept a plaintext token argument`);
  }
});
