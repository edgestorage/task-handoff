import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nacl from "tweetnacl";
import { CloudRelayConnector } from "../src/control-plane/cloud-connectivity/relay-connector.ts";
import { RelayTraceRecorder, relayTraceEnabled, relayTraceFromEnvironment } from "../src/control-plane/cloud-connectivity/relay-trace.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-trace-test-"));

const LIVE_FILE = "relay-trace.jsonl";

const traceFiles = (directory: string) => fs.readdirSync(directory).filter((name) => name.startsWith("relay-trace")).sort();

const liveFile = (directory: string) => path.join(directory, LIVE_FILE);

const readEntries = (filePath: string) => fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const captureEntries = (filePath: string) => readEntries(filePath).filter((line) => line.type === "relay-trace-entry");

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
};

const waitForEntries = async (directory: string, expected: number) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const file = liveFile(directory);
    if (fs.existsSync(file)) {
      const entries = captureEntries(file);
      if (entries.length >= expected) return { file, entries };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} captured entries`);
};

test("relay trace stays inert while disabled and writes nothing to disk", () => {
  const directory = tempDir();
  const disabled = new RelayTraceRecorder({ enabled: false, directory });
  disabled.record({ channelId: "relay_channel_a", direction: "in", kind: "request", plaintext: Buffer.from("{}"), sealedBytes: 18, wireBytes: 24 });
  disabled.close();
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().writtenEntries, 0);
  assert.deepEqual(traceFiles(directory), []);
});

test("relay trace writes decoded envelopes into its own jsonl file", () => {
  const directory = tempDir();
  const trace = new RelayTraceRecorder({ enabled: true, directory });
  trace.record({ channelId: "relay_channel_a", direction: "in", kind: "request", plaintext: Buffer.from('{"type":"request"}'), sealedBytes: 34, wireBytes: 48, detail: { path: "/instances", method: "GET" } });
  trace.close();
  assert.deepEqual(traceFiles(directory), [LIVE_FILE]);
  const lines = readEntries(liveFile(directory));
  assert.equal(lines.length, 1, "a single envelope is a single jsonl line");
  assert.equal(lines[0].type, "relay-trace-entry");
  assert.equal(lines[0].direction, "in");
  assert.equal(lines[0].detail.path, "/instances");
  assert.deepEqual([lines[0].plaintextBytes, lines[0].sealedBytes, lines[0].wireBytes], [18, 34, 48]);
});

test("relay trace truncates oversized bodies but keeps the digest and the true byte count", () => {
  const directory = tempDir();
  const trace = new RelayTraceRecorder({ enabled: true, directory, maxEntryBytes: 32 });
  trace.record({ channelId: "relay_channel_a", direction: "in", kind: "request", plaintext: Buffer.alloc(4_096, 0x61), sealedBytes: 4_112, wireBytes: 5_484, detail: { path: "/instances" } });
  trace.close();
  const entry = captureEntries(liveFile(directory))[0];
  assert.equal(entry.truncated, true);
  assert.equal(entry.plaintextBytes, 4_096);
  assert.equal(entry.body.length, 32);
  assert.match(entry.bodyDigest, /^sha256:/);
  assert.deepEqual([entry.sealedBytes, entry.wireBytes], [4_112, 5_484]);
});

test("relay trace rolls over like a log, overwriting the oldest capture", () => {
  const directory = tempDir();
  const trace = new RelayTraceRecorder({ enabled: true, directory, maxBytes: 1_024, backupCount: 1 });
  for (let index = 0; index < 400; index += 1) {
    trace.record({ channelId: "relay_channel_a", direction: "out", kind: "event", plaintext: Buffer.from(`payload-${index}`), sealedBytes: 26, wireBytes: 35, detail: { eventType: "ai-session.patch" } });
  }
  trace.close();
  // One live file plus exactly one overwritten generation: the capture is bounded, not stopped.
  assert.deepEqual([...traceFiles(directory)].sort(), ["relay-trace.1.jsonl", LIVE_FILE].sort());
  const status = trace.status();
  assert.equal(status.error, undefined);
  assert.equal(status.writtenEntries, 400, "rotating must not drop entries from the count");
  assert.ok(status.writtenBytes > 400 * 200, `capture tracked ${status.writtenBytes} bytes`);

  const live = captureEntries(liveFile(directory));
  const previous = captureEntries(path.join(directory, "relay-trace.1.jsonl"));
  assert.ok(live.length > 0 && previous.length > 0);
  // The newest window survives and the oldest traffic was overwritten rather than kept.
  assert.equal(live.at(-1).body, "payload-399");
  const onDisk = fs.readFileSync(liveFile(directory), "utf8") + fs.readFileSync(path.join(directory, "relay-trace.1.jsonl"), "utf8");
  assert.ok(!onDisk.includes("payload-0\""), "the oldest entry must be overwritten");
  const totalBytes = fs.statSync(liveFile(directory)).size + fs.statSync(path.join(directory, "relay-trace.1.jsonl")).size;
  assert.ok(totalBytes <= 2 * 1_024 + 512, `two generations hold ${totalBytes} bytes`);
});

test("relay trace uses its own switch and ignores the diagnostic logging flag", () => {
  assert.equal(relayTraceEnabled({}), false);
  assert.equal(relayTraceEnabled({ TASK_HANDOFF_RELAY_TRACE: "0" }), false);
  assert.equal(relayTraceEnabled({ TASK_HANDOFF_RELAY_TRACE: "off" }), false);
  // Diagnostic logging must never turn relay payload capture on.
  assert.equal(relayTraceEnabled({ TASK_HANDOFF_DIAGNOSTIC_LOGS: "1" }), false);
  assert.equal(relayTraceFromEnvironment({ TASK_HANDOFF_DIAGNOSTIC_LOGS: "true" }, "/tmp/relay-trace-unused").enabled, false);
  assert.equal(relayTraceEnabled({ TASK_HANDOFF_RELAY_TRACE: "1" }), true);

  const target = path.join(tempDir(), "not-created");
  const sized = relayTraceFromEnvironment({ TASK_HANDOFF_RELAY_TRACE: "true", TASK_HANDOFF_RELAY_TRACE_BYTES: "1048576", TASK_HANDOFF_RELAY_TRACE_BACKUPS: "0", TASK_HANDOFF_RELAY_TRACE_ENTRY_BYTES: "512" }, target);
  const status = sized.status();
  assert.deepEqual([sized.enabled, status.maxBytes, status.backupCount, status.maxEntryBytes], [true, 1_048_576, 0, 512]);
  assert.equal(status.path, path.join(target, LIVE_FILE));
  // Arming the flag alone must not create anything: files appear with the first envelope.
  assert.equal(fs.existsSync(target), false);
});

test("relay connector writes decoded traffic that the relay itself only sees as ciphertext", { timeout: 5_000 }, async () => {
  const sockets: any[] = [];
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    sent: any[] = [];
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(url: string) { (this as any).url = url; sockets.push(this); queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit("open"); }); }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    once(event: string, listener: (...args: any[]) => void) { const wrapper = (...args: any[]) => { this.off(event, wrapper); listener(...args); }; this.on(event, wrapper); }
    off(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener)); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    send(data: string) {
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "attach") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "attached", channelId: "relay_channel_a" }) }));
    }
    close(code?: number, reason?: string) { this.readyState = FakeSocket.CLOSED; queueMicrotask(() => this.emit("close", code, reason)); }
    receive(value: unknown) { this.emit("message", { toString: () => JSON.stringify(value) }); }
  }

  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const ticket = { protocolVersion: "2026-08-10", audience: "task-handoff:control-plane-access", ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(24), trafficClasses: ["interactive"], issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), signature: "s".repeat(32) };
  const attach = { protocolVersion: "2026-08-10", audience: "task-handoff:relay-control-plane-attach", allocationId: "allocation_a", relayId: "relay_a", role: "control-plane", controlPlaneId: ticket.controlPlaneId, accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, bindingId: ticket.bindingId, ticketId: ticket.ticketId, bindingRevision: ticket.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt: ticket.issuedAt, expiresAt: ticket.expiresAt, signature: "s".repeat(32) };
  const sessionKey = new Uint8Array(32);
  const identity = { acceptCloudAccessHandshake: () => ({ response: { serverEphemeralPublicKey: "c".repeat(43), transcript: "transcript", signature: "s".repeat(32) }, sessionKey }), publicIdentity: () => ({ publicKey: "c".repeat(43) }) };
  const directory = tempDir();
  const trace = new RelayTraceRecorder({ enabled: true, directory });
  const connector = new CloudRelayConnector({
    identity,
    bridge: { request: async (_actor, input) => ({ status: 200, body: { data: { path: input.path } } }) } as any,
    webSocket: FakeSocket as any,
    trace,
  });

  const connection = await connector.connect({ relayUrl: "ws://localhost:8080/connect", allocation: { attach, ticket } });
  sockets[0].receive({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId: "relay_channel_a", sequence: 0, kind: "handshake", ciphertext: Buffer.from(JSON.stringify({ ticketId: ticket.ticketId, deviceSessionId: ticket.deviceSessionId, clientEphemeralPublicKey: "b".repeat(43) })).toString("base64url") } });
  // The data frame can only be consumed once the encrypted session has registered its
  // listener, which happens after the handshake response goes back over the socket.
  await waitFor(() => sockets[0].sent.some((message) => message.type === "frame" && message.frame.kind === "handshake"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const request = Buffer.from(JSON.stringify({ type: "request", id: "request_1", body: { path: "/instances", method: "GET", headers: {} } }));
  const clientNonce = new Uint8Array(24);
  clientNonce[0] = 1;
  const sealed = nacl.secretbox(request, clientNonce, sessionKey);
  sockets[0].receive({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId: "relay_channel_a", sequence: 1, kind: "data", ciphertext: Buffer.from(sealed).toString("base64url") } });

  // The attach handshake records its own `channel-opened` entry first, so the decoded
  // request/response pair arrives as the second and third entries.
  const { entries } = await waitForEntries(directory, 3);
  const inbound = entries.find((entry) => entry.direction === "in" && entry.kind === "request");
  const outbound = entries.find((entry) => entry.direction === "out");
  assert.ok(inbound, "expected a decoded inbound request entry");
  assert.ok(outbound, "expected a decoded outbound response entry");
  assert.equal(inbound.kind, "request");
  assert.deepEqual([inbound.detail.path, inbound.detail.method], ["/instances", "GET"]);
  assert.equal(inbound.plaintextBytes, request.byteLength);
  assert.equal(inbound.sealedBytes, request.byteLength + 16);
  // Base64 expansion is exactly what the capture has to make visible: the Relay and every
  // hop in between carry the wire size, not the plaintext size.
  assert.ok(inbound.wireBytes > inbound.sealedBytes, `${inbound.wireBytes} <= ${inbound.sealedBytes}`);
  assert.equal(outbound.kind, "response");
  assert.equal(outbound.detail.status, 200);
  assert.match(outbound.body as string, /"status":200/);

  await connection.close("test-done");
  trace.close();
  assert.equal(sockets[0].readyState, FakeSocket.CLOSED);
});
