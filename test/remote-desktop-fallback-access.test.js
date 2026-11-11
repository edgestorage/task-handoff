const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const ts = require("typescript");
require("./workspace-require.js").registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText,
  filename,
);

const { DesktopAccess } = require("../packages/control-plane/src/control-plane/remote-desktop/access.ts");

const principal = {
  actor: {
    type: "user",
    userId: "user_1",
    authorizationRevision: 1,
    nodeScope: [],
    instanceScope: [],
  },
  deviceSessionId: "device_1",
};
const captureSelection = { sourceRef: "display" };
const ice = { iceServers: [], iceCredentialsExpiresAt: null };

function accessFor(t, { now = { value: 0 }, capacity, fallback } = {}) {
  const requests = [];
  const access = new DesktopAccess({
    request: async (_instanceId, operation, input) => {
      requests.push({ operation, input });
      if (operation === "reserve" || operation === "takeover") {
        return {
          type: "reserved",
          attachToken: `attach_${requests.length}`,
          attachExpiresAt: now.value + 30_000,
          snapshot: {
            viewerSessionId: `rdv_${requests.length}`,
            sessionRevision: 1,
            phase: "negotiating",
            captureSelection,
            sessionExpiresAt: now.value + 60_000,
            idleExpiresAt: null,
            mediaPaused: true,
            reason: null,
          },
        };
      }
      if (operation === "snapshot") return { snapshot: input };
      return { type: "ok" };
    },
    attach: async () => undefined,
    fallback,
    renewAuthorization: async () => true,
    issueIce: () => ice,
    fallbackCapacity: capacity,
    now: () => now.value,
  });
  t.after(() => access.shutdown());
  return { access, requests, now };
}

async function createSession(access, instanceId, requestId) {
  return access.create(principal, instanceId, "node_1", requestId, captureSelection);
}

function ticket(url, role) {
  return new URL(`http://control-plane${url.replace(`/${role}`, `/${role}`)}`).searchParams.get("ticket");
}

test("fallback capacity rejects a second session before issuing tickets", async (t) => {
  const { access, now } = accessFor(t, { capacity: { maxSessions: 1, maxTotalBitrate: 4_000_000 } });
  const first = await createSession(access, "inst_1", "request_1");
  const second = await createSession(access, "inst_1", "request_2");
  now.value = 3_000;
  assert.ok(access.issueFallback(principal, "inst_1", first.snapshot.viewerSessionId, 4_000_000));
  assert.throws(
    () => access.issueFallback(principal, "inst_1", second.snapshot.viewerSessionId, 4_000_000),
    (error) => error.code === "REMOTE_DESKTOP_FALLBACK_CAPACITY" && error.statusCode === 503,
  );
});

test("progressive fallback tickets are available during WebRTC head start", async (t) => {
  const { access, now } = accessFor(t);
  const created = await createSession(access, "inst_1", "request_1");
  now.value = 500;
  const issued = access.issueFallback(principal, "inst_1", created.snapshot.viewerSessionId, 4_000_000);
  assert.match(issued.generation, /^fgen_/);
  assert.match(issued.mediaUrl, /\/fallback\/media\?ticket=/);
});

test("fallback tickets are role-bound, one-time and reject a stale generation", async (t) => {
  const headers = [];
  const { access, now } = accessFor(t, {
    capacity: { maxSessions: 1, maxTotalBitrate: 4_000_000 },
    fallback: async (_instanceId, role, _socket, context) => headers.push({ role, context }),
  });
  const created = await createSession(access, "inst_1", "request_1");
  const viewer = created.snapshot.viewerSessionId;
  now.value = 3_000;
  const issued = access.issueFallback(principal, "inst_1", viewer, 4_000_000);
  const mediaTicket = ticket(issued.mediaUrl, "media");
  const controlTicket = ticket(issued.controlUrl, "control");
  assert.throws(
    () => access.consumeFallback(principal, "inst_1", viewer, "control", mediaTicket),
    (error) => error.code === "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID",
  );
  const authorized = access.consumeFallback(principal, "inst_1", viewer, "media", mediaTicket);
  assert.equal(authorized.generation, issued.generation);
  assert.throws(
    () => access.consumeFallback(principal, "inst_1", viewer, "media", mediaTicket),
    (error) => error.code === "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID",
  );
  await assert.rejects(
    access.connectFallback(authorized.entry, "media", "fgen_stale", new EventEmitter()),
    (error) => error.code === "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID",
  );

  const socket = Object.assign(new EventEmitter(), { close: () => undefined });
  await access.connectFallback(authorized.entry, "media", issued.generation, socket);
  assert.equal(headers.length, 1);
  assert.equal(headers[0].role, "media");
  assert.equal(headers[0].context["x-task-handoff-desktop-viewer"], viewer);
  assert.equal(headers[0].context["x-task-handoff-desktop-generation"], issued.generation);

  now.value = issued.ticketExpiresAt;
  assert.throws(
    () => access.consumeFallback(principal, "inst_1", viewer, "control", controlTicket),
    (error) => error.code === "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID",
  );
});

test("replacing a fallback generation ignores late closes from the old pair", async (t) => {
  const { access, now } = accessFor(t, {
    capacity: { maxSessions: 1, maxTotalBitrate: 4_000_000 },
    fallback: async () => undefined,
  });
  const created = await createSession(access, "inst_1", "request_1");
  const viewer = created.snapshot.viewerSessionId;
  now.value = 3_000;
  const first = access.issueFallback(principal, "inst_1", viewer, 4_000_000);
  const media = Object.assign(new EventEmitter(), { close: () => undefined });
  const control = Object.assign(new EventEmitter(), { close: () => undefined });
  await access.connectFallback(
    access.consumeFallback(principal, "inst_1", viewer, "media", ticket(first.mediaUrl, "media")).entry,
    "media",
    first.generation,
    media,
  );
  await access.connectFallback(
    access.consumeFallback(principal, "inst_1", viewer, "control", ticket(first.controlUrl, "control")).entry,
    "control",
    first.generation,
    control,
  );

  const second = access.issueFallback(principal, "inst_1", viewer, 4_000_000);
  media.emit("close");
  control.emit("close");

  assert.doesNotThrow(() => access.consumeFallback(principal, "inst_1", viewer, "media", ticket(second.mediaUrl, "media")));
  assert.doesNotThrow(() => access.consumeFallback(principal, "inst_1", viewer, "control", ticket(second.controlUrl, "control")));
});
