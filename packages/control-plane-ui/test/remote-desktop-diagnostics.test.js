import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteDesktopDiagnostics,
  formatRemoteDesktopDiagnosticMessages,
  remoteDesktopErrorFields,
} from "../src/apps/control-plane/instance-detail/remoteDesktopDiagnostics.ts";

test("remote desktop diagnostics stay behind the global diagnostic setting", () => {
  const entries = [];
  let enabled = false;
  const diagnostics = createRemoteDesktopDiagnostics({
    enabled: () => enabled,
    context: () => ({ instanceId: "instance", viewerSessionId: "viewer" }),
    sink: entry => entries.push(entry),
  });

  diagnostics.record("wire.send", { channel: "control", wireType: "control.request" });
  assert.deepEqual(entries, []);
  assert.deepEqual(diagnostics.snapshot(), []);

  enabled = true;
  diagnostics.record("wire.send", { channel: "control", wireType: "control.request" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "wire.send");
  assert.equal(entries[0].instanceId, "instance");
  assert.equal(entries[0].viewerSessionId, "viewer");
  assert.equal(entries[0].sequence, 1);
  assert.equal(Number.isFinite(Date.parse(entries[0].time)), true);

  enabled = false;
  diagnostics.record("wire.send", { channel: "control", wireType: "input.resume" });
  assert.equal(entries.length, 1);
  assert.equal(diagnostics.snapshot().length, 1);
});

test("remote desktop diagnostics are bounded and isolate sink failures", () => {
  const diagnostics = createRemoteDesktopDiagnostics({
    enabled: () => true,
    context: () => ({ instanceId: "instance" }),
    sink: () => { throw new Error("desktop bridge unavailable"); },
    maxEntries: 2,
  });

  assert.doesNotThrow(() => {
    diagnostics.record("one");
    diagnostics.record("two");
    diagnostics.record("three");
  });
  assert.deepEqual(diagnostics.snapshot().map(entry => entry.event), ["two", "three"]);
});

test("remote desktop error fields keep bounded correlation without payloads", () => {
  const error = Object.assign(new Error("message"), {
    name: "RemoteDesktopError",
    code: "REMOTE_DESKTOP_TEST",
    requestId: "request",
    status: 409,
    stack: "stack".repeat(2_000),
    payload: { clipboard: "must not be logged" },
  });

  const fields = remoteDesktopErrorFields(error);
  assert.equal(fields.name, "RemoteDesktopError");
  assert.equal(fields.message, "message");
  assert.equal(fields.code, "REMOTE_DESKTOP_TEST");
  assert.equal(fields.requestId, "request");
  assert.equal(fields.status, 409);
  assert.equal(fields.stack.length, 4_000);
  assert.equal(JSON.stringify(fields).includes("must not be logged"), false);
});

test("desktop diagnostic chunks fit the shell limit and preserve the entry", () => {
  const entry = {
    time: "2026-11-11T00:00:00.000Z",
    sequence: 7,
    event: "control.message.failed",
    instanceId: "instance",
    viewerSessionId: "viewer",
    sessionRevision: 9,
    controlRevision: 4,
    recentFrames: "receive:control:input.resumed#12:84B | send:control:input.resume#13:121B",
  };
  const messages = formatRemoteDesktopDiagnosticMessages(entry);

  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => message.length <= 240));
  const decoded = JSON.parse(messages.map(message => message.replace(/^remote-desktop \d+ \S+ \d+\/\d+ /, "")).join(""));
  assert.deepEqual(decoded, entry);
});
