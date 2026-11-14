import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";
import { DesktopTurnSettingsService } from "../src/control-plane/remote-desktop/turn-settings.ts";
import { registerRemoteDesktopRoutes } from "../src/control-plane/http/remote-desktop-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";
import { cloudEventAllowed, routeAuthorization } from "../src/control-plane/http/cloud-relay-authorization.ts";
import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";
import { CloudAccountSessionService } from "../src/control-plane/cloud-connectivity/account-session.ts";
import { CustomTurnSettingsSchema, DesktopConnectionOptionsSchema } from "@task-handoff/protocol/control-plane-desktop";
import { DesktopIceConfigSchema, unsupportedRemoteDesktopCapabilities } from "@task-handoff/protocol/remote-desktop";

const input = { enabled: true, urls: ["turn:relay.example.com:3478?transport=udp"], authentication: "password" as const, username: "desktop", secret: "private-password", expectedRevision: 0 };
async function fixture(t: TestContext, initialize = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-turn-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths, { dialect: "sqlite" });
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath); secrets.init();
  let now = Date.now();
  const service = new DesktopTurnSettingsService(database.desktopTurn, secrets, () => now);
  t.after(async () => { await database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  if (initialize) await service.init();
  return { root, paths, database, secrets, service, time: (value: number) => { now = value; } };
}

test("TURN settings encrypt secrets, survive restart, preserve omitted credentials, and serialize revision conflicts", async t => {
  const { database, service, secrets } = await fixture(t);
  const saved = await service.update(input);
  assert.equal(saved.configured, true);
  assert.doesNotMatch(JSON.stringify(saved), /private-password|secretCiphertext/);
  const record = (await database.desktopTurn.get())!;
  assert.doesNotMatch(JSON.stringify(record), /private-password/);
  assert.match(record.secretCiphertext!, /^v1\./);
  const restarted = new DesktopTurnSettingsService(database.desktopTurn, secrets); await restarted.init();
  assert.equal(restarted.issue().iceServers[0].credential, "private-password");
  const { secret: _, ...retained } = input;
  const writes = await Promise.allSettled([
    restarted.update({ ...retained, expectedRevision: 1, username: "new-user" }),
    restarted.update({ ...retained, expectedRevision: 1, username: "stale-user" }),
  ]);
  assert.equal(writes[0].status, "fulfilled");
  assert.equal(writes[1].status, "rejected");
  assert.equal((writes[1] as PromiseRejectedResult).reason.code, "REMOTE_DESKTOP_TURN_REVISION_CONFLICT");
  assert.equal(restarted.issue().iceServers[0].username, "new-user");
  assert.equal(restarted.issue().iceServers[0].credential, "private-password");
  await assert.rejects(restarted.update({ ...retained, expectedRevision: 2, authentication: "shared-secret" }), { code: "REMOTE_DESKTOP_TURN_SECRET_REQUIRED" });
  assert.equal(restarted.snapshot().revision, 2);
  await restarted.update({ ...retained, expectedRevision: 2, enabled: false });
  assert.equal(restarted.snapshot().configured, false);
  assert.deepEqual(restarted.issue(), { iceServers: [], iceCredentialsExpiresAt: null });
});

test("shared-secret configuration issues current HMAC credentials and rotates without restarting CP", async t => {
  const { service, time } = await fixture(t);
  const now = 1_800_000_000_000; time(now);
  await service.update({ ...input, authentication: "shared-secret", username: "", secret: "shared-one" });
  let ice = service.issue();
  assert.equal(ice.iceCredentialsExpiresAt, now + 600_000);
  assert.equal(ice.iceServers[0].credential, createHmac("sha1", "shared-one").update(ice.iceServers[0].username!).digest("base64"));
  await service.update({ ...input, authentication: "shared-secret", username: "", secret: "shared-two", expectedRevision: 1 });
  time(now + 300_000); ice = service.issue();
  assert.equal(ice.iceCredentialsExpiresAt, now + 900_000);
  assert.equal(ice.iceServers[0].credential, createHmac("sha1", "shared-two").update(ice.iceServers[0].username!).digest("base64"));
});

test("v0.0.51 deployment import is one-time and retains clock health validation", async t => {
  const f = await fixture(t, false);
  const configFile = path.join(f.root, "legacy.json"), healthFile = path.join(f.root, "clock.json"), secretFile = path.join(f.root, "secret");
  const now = Date.now(); f.time(now);
  fs.writeFileSync(secretFile, "legacy-shared-secret\n");
  fs.writeFileSync(healthFile, JSON.stringify({ measuredAt: now, synchronized: true, offsetMs: 0 }));
  fs.writeFileSync(configFile, JSON.stringify({ region: "one", regions: { one: { urls: input.urls } }, secretFile, clockHealthFile: healthFile }));
  const previous = process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG;
  process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG = configFile;
  try {
    await f.service.init();
    assert.equal(f.service.issue().iceServers.length, 1);
    fs.writeFileSync(healthFile, JSON.stringify({ measuredAt: now, synchronized: false, offsetMs: 0 }));
    assert.throws(() => f.service.issue(), { code: "REMOTE_DESKTOP_TURN_UNAVAILABLE" });
    const revision = f.service.snapshot().revision;
    await f.service.update({ ...input, enabled: false, expectedRevision: revision });
    fs.writeFileSync(configFile, "invalid JSON must not be read again");
    const restarted = new DesktopTurnSettingsService(f.database.desktopTurn, f.secrets); await restarted.init();
    assert.equal(restarted.snapshot().enabled, false);
    assert.equal(restarted.snapshot().revision, revision + 1);
  } finally {
    if (previous === undefined) delete process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG;
    else process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG = previous;
  }
});

test("settings permission and viewer options are separate; disabled TURN never invokes the issuer", async t => {
  const { service } = await fixture(t);
  const app = Fastify(); await app.register(websocket);
  let permissionIds = ["settings:manage", "instances:interactive"], signedIn = false;
  const actor = () => ({ type: "user", identityId: "identity_1", userId: "user_1", permissionIds, roleIds: [], nodeScope: { kind: "all" }, instanceScope: { kind: "inherit-node-scope" }, authorizationRevision: 1, requiresPasswordChange: false } as const);
  app.addHook("onRequest", async request => { setControlPlaneRequestActor(request, actor() as any); });
  const bus = new ControlPlaneEventBus(), events: any[] = [];
  bus.on(event => events.push(event));
  const capability = { ...unsupportedRemoteDesktopCapabilities(), available: true, runtimeKind: "local" };
  let sessionIndex = 0;
  const access = registerRemoteDesktopRoutes({
    app, service: {
      desktopTurn: service, requireControlledInstance: async () => ({ id: "inst_1", nodeId: "node_1", capabilities: { features: { remoteDesktop: capability } } }),
      getSettings: () => ({}),
      desktopRequest: async (_id: string, operation: string, command: any) => operation === "reserve" ? {
        type: "reserved", attachToken: "private-attach", attachExpiresAt: Date.now() + 30_000,
        snapshot: { viewerSessionId: `rdv_${++sessionIndex}`, sessionRevision: 1, phase: "starting", captureSelection: command.captureSelection, sessionExpiresAt: Date.now() + 60_000, idleExpiresAt: null, mediaPaused: false, reason: null },
      } : { type: "stopped" },
    } as any, events: bus, authorizationConnections: { track: () => () => {} } as any,
    principal: async () => ({ actor: actor() as any, deviceSessionId: "device_1" }), renewAuthorization: async () => true,
    cloudSignedIn: () => signedIn,
  });
  t.after(async () => { await access.shutdown(); await app.close(); }); await app.ready();
  const url = "/api/control-plane/desktop-turn";
  const saved = await app.inject({ method: "PUT", url, payload: input }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.headers["cache-control"], "no-store");
  assert.doesNotMatch(saved.body + JSON.stringify(events), /private-password|secretCiphertext/);
  assert.equal(events.some(e => e.type === "desktop-connection-options.changed"), true);
  permissionIds = ["instances:interactive"];
  assert.equal((await app.inject({ url })).statusCode, 403);
  const optionsUrl = "/api/controlled-instances/inst_1/remote-desktop/connection-options";
  let options = (await app.inject({ url: optionsUrl })).json().data;
  assert.deepEqual(options, { customTurn: { configured: true }, cloudTurn: { signedIn: false, available: false } });
  signedIn = true;
  options = (await app.inject({ url: optionsUrl })).json().data;
  assert.equal(options.cloudTurn.signedIn, true); assert.equal(options.cloudTurn.available, false);
  // A broken custom server must not prevent explicitly selected P2P/WS paths.
  service.issue = () => { throw Error("issuer must not run"); };
  const created = await app.inject({ method: "POST", url: "/api/controlled-instances/inst_1/remote-desktop-sessions", payload: { requestId: "create-without-turn", selection: { sourceRef: "display-primary" }, turnSource: "none" } });
  assert.equal(created.statusCode, 200, created.body); assert.deepEqual(created.json().data.iceServers, []);
  assert.deepEqual(routeAuthorization("GET", url), { action: "manage-settings", resource: { type: "control-plane-settings" } });
  assert.equal(cloudEventAllowed({ permissionIds: ["instances:interactive"] }, { type: "desktop-connection-options.changed", topic: "desktop-connection-options" }), true);
  assert.equal(cloudEventAllowed({ permissionIds: ["instances:interactive"] }, { type: "desktop-turn.updated", topic: "system" }), false);
});

test("account login/logout publishes only actual sign-in changes; readers ignore future fields", async t => {
  const { root } = await fixture(t); let changes = 0;
  const account = new CloudAccountSessionService({ statePath: path.join(root, "account.json"), serviceOrigin: "https://cloud.example.com", onSignedInChanged: () => { changes++; } });
  account.init();
  account.signOut(); assert.equal(changes, 0);
  account.beginRequest({ requestId: "request", authorizationUrl: "https://cloud.example.com/authorize", scope: "account:sign-in", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  account.complete({ accountId: "account", email: "test@example.com", deviceSessionId: "device", refreshCredential: "r".repeat(40), sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(changes, 1); account.signOut(); assert.equal(changes, 2);
  const options = { customTurn: { configured: true, future: 1 }, cloudTurn: { signedIn: true, available: false, future: 1 }, future: 1 };
  assert.equal(DesktopConnectionOptionsSchema.parse(options).customTurn.configured, true);
  assert.equal(CustomTurnSettingsSchema.parse({ ...input, configured: true, secretConfigured: true, revision: 3, future: 1 }).revision, 3);
});

test("ICE renewal keeps the selected issuer and sends updated credentials to both peers", async t => {
  const { service, time } = await fixture(t);
  let now = Date.now(); time(now);
  await service.update({ ...input, authentication: "shared-secret", username: "", secret: "first-key" });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { DesktopAccess } = await import("../src/control-plane/remote-desktop/access.ts");
  const { EventEmitter } = await import("node:events");
  let relay: any;
  const upstream: any[] = [], browser: any[] = [];
  const snapshot = { viewerSessionId: "rdv_renew", sessionRevision: 1, phase: "negotiating", captureSelection: { sourceRef: "display" }, sessionExpiresAt: now + 8 * 3_600_000, idleExpiresAt: null, mediaPaused: false, reason: null };
  const access = new DesktopAccess({
    now: () => now,
    request: async (_id, operation) => operation === "reserve" ? { type: "reserved", attachToken: "private", attachExpiresAt: now + 30_000, snapshot } : { type: "stopped" },
    attach: async (_id, socket) => { relay = socket; socket.on("message", value => upstream.push(JSON.parse(String(value)))); },
    renewAuthorization: async () => true,
    issueIce: () => { throw Error("global issuer must not override the session selection"); },
  });
  t.after(() => access.shutdown());
  const principal = { actor: { type: "user", userId: "user", authorizationRevision: 1 } as any, deviceSessionId: "device" };
  const created = await access.create(principal, "inst", "node", "renew-create", { sourceRef: "display" }, undefined, service.issue(), () => service.issue());
  const entry = access.consume(principal, "inst", created.snapshot.viewerSessionId, created.ticket);
  const socket = new EventEmitter() as any; socket.readyState = 1;
  socket.send = (value: any) => browser.push(JSON.parse(String(value)));
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  await access.connect(entry, socket);
  relay.send(JSON.stringify({ type: "snapshot", snapshot }));
  const configured = browser.find(v => v.type === "configureIce"); assert.ok(configured);
  relay.send(JSON.stringify({ type: "acknowledged", requestId: configured.requestId }));
  await service.update({ ...input, authentication: "shared-secret", username: "", secret: "second-key", expectedRevision: 1 });
  now += 480_000; time(now); t.mock.timers.tick(480_000);
  await new Promise(resolve => setImmediate(resolve));
  const next = browser.filter(v => v.type === "configureIce").at(-1);
  assert.notEqual(next.requestId, configured.requestId);
  assert.equal(next.iceServers[0].credential, createHmac("sha1", "second-key").update(next.iceServers[0].username).digest("base64"));
  assert.deepEqual(upstream.filter(v => v.type === "configureIce").at(-1), next);
});


test("saved credentials and addresses must fit the actual ICE configuration contract", async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.update({ ...input, secret: "x".repeat(1025) }));
  await assert.rejects(service.update({ ...input, urls: ["turn:[::::]:3478"] }));
  await assert.rejects(service.update({ ...input, urls: ["turn:relay.example.com:99999"] }));
  assert.equal(service.snapshot().revision, 0);
  await service.update({ ...input, authentication: "shared-secret", secret: "x".repeat(2048) });
  assert.equal(DesktopIceConfigSchema.parse(service.issue()).iceServers.length, 1);
});
