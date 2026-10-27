import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nacl from "tweetnacl";
import { decodeRelayFrame, encodeRelayFrame, RELAY_FRAMING_PROTOCOL_VERSION, RELAY_SESSION_PROTOCOL_VERSION, RelaySessionAudience, type RelayFramePayload } from "@task-handoff/cloud-contracts";
import { CloudRelayConnector } from "../src/control-plane/cloud-connectivity/relay-connector.ts";
import { RelayTraceRecorder, relayTraceEnabled, relayTraceFromEnvironment } from "../src/control-plane/cloud-connectivity/relay-trace.ts";
import { activeDeviceTrust, cloudClientDevice, cloudRelayIdentity, trustedDeviceSessions } from "./support/cloud-relay-client-auth.ts";

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
  const device = cloudClientDevice();
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    sent: any[] = [];
    frames: RelayFramePayload[] = [];
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(url: string) { (this as any).url = url; sockets.push(this); queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit("open"); }); }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    once(event: string, listener: (...args: any[]) => void) { const wrapper = (...args: any[]) => { this.off(event, wrapper); listener(...args); }; this.on(event, wrapper); }
    off(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener)); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    send(data: string | Uint8Array) {
      if (typeof data !== "string") { this.frames.push(decodeRelayFrame(data)); return; }
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "attach") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "attached", channelId: "relay_channel_a", allocationId: "allocation_a", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }) }));
    }
    close(code?: number, reason?: string) { this.readyState = FakeSocket.CLOSED; queueMicrotask(() => this.emit("close", code, reason)); }
    receive(frame: RelayFramePayload) { this.emit("message", Buffer.from(encodeRelayFrame(frame)), true); }
  }

  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_a",
    accountId: "account_a",
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "t".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "relay_session_a",
    grantId: "grant_a",
    generation: 1,
    allocationId: "allocation_a",
    accessTicketId: "access_ticket_a",
    relayId: "relay_a",
    relayRegion: "eu-west",
    relayUrl: "ws://localhost:8080/connect",
    accountId: transcriptTicket.accountId,
    ownerAccountId: transcriptTicket.ownerAccountId,
    accessMode: transcriptTicket.accessMode,
    accessRoleId: transcriptTicket.accessRoleId,
    deviceSessionId: transcriptTicket.deviceSessionId,
    controlPlaneId: transcriptTicket.controlPlaneId,
    bindingId: transcriptTicket.bindingId,
    bindingRevision: transcriptTicket.bindingRevision,
    targetPublicKeyFingerprint: fingerprint,
    clientProofPublicKey: device.publicKey,
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: transcriptTicket,
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(86),
  } as const;
  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: "task-handoff:relay-control-plane-attach", allocationId: grant.allocationId, relayId: grant.relayId, role: "control-plane", controlPlaneId: grant.controlPlaneId, accountId: grant.accountId, ownerAccountId: grant.ownerAccountId, accessMode: grant.accessMode, accessRoleId: grant.accessRoleId, deviceSessionId: grant.deviceSessionId, bindingId: grant.bindingId, ticketId: grant.accessTicketId, bindingRevision: grant.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt, expiresAt: new Date(now + 8 * 60_000).toISOString(), signature: "s".repeat(32) };
  const sessionKey = new Uint8Array(32);
  const identity = cloudRelayIdentity({ fingerprint, sessionKey });
  const directory = tempDir();
  const trace = new RelayTraceRecorder({ enabled: true, directory });
  const connector = new CloudRelayConnector({
    identity,
    bridge: { request: async (_actor, input) => ({ status: 200, body: { data: { path: input.path } } }) } as any,
    webSocket: FakeSocket as any,
    trace,
    deviceTrust: activeDeviceTrust(),
    trustedSessions: trustedDeviceSessions(),
  });

  const connection = await connector.connect({ relayUrl: grant.relayUrl, allocation: { attach, grant } });
  const hello = device.hello({ ticket: transcriptTicket, grant });
  sockets[0].receive({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(hello)) });
  // The data frame can only be consumed once the encrypted session has registered its
  // listener, which happens after the handshake response goes back over the socket.
  await waitFor(() => sockets[0].frames.some((frame) => frame.kind === "handshake"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const request = Buffer.from(JSON.stringify({ type: "request", id: "request_1", body: { path: "/instances", method: "GET", headers: {} } }));
  const clientNonce = new Uint8Array(24);
  clientNonce[0] = 1;
  const sealed = nacl.secretbox(request, clientNonce, sessionKey);
  sockets[0].receive({ kind: "data", sequence: 1, payload: sealed });

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
  // The capture has to make the wire overhead visible: sealed bytes plus the fixed
  // frame header are what the Relay and every hop in between carry.
  assert.ok(inbound.wireBytes > inbound.sealedBytes, `${inbound.wireBytes} <= ${inbound.sealedBytes}`);
  assert.equal(outbound.kind, "response");
  assert.equal(outbound.detail.status, 200);
  assert.match(outbound.body as string, /"status":200/);

  await connection.close("test-done");
  trace.close();
  assert.equal(sockets[0].readyState, FakeSocket.CLOSED);
});

test("relay connector times out when the Relay never acknowledges attach", { timeout: 2_000 }, async () => {
  const sockets: any[] = [];
  class HangingSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = HangingSocket.CONNECTING;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(url: string) {
      (this as any).url = url;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = HangingSocket.OPEN; this.emit("open"); });
    }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    once(event: string, listener: (...args: any[]) => void) { const wrapper = (...args: any[]) => { this.off(event, wrapper); listener(...args); }; this.on(event, wrapper); }
    off(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener)); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    send() { /* deliberately never acknowledges the attach */ }
    close(code?: number, reason?: string) { this.readyState = HangingSocket.CLOSED; queueMicrotask(() => this.emit("close", code, reason)); }
  }

  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_a",
    accountId: "account_a",
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "t".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "relay_session_a",
    grantId: "grant_a",
    generation: 1,
    allocationId: "allocation_a",
    accessTicketId: "access_ticket_a",
    relayId: "relay_a",
    relayRegion: "eu-west",
    relayUrl: "ws://localhost:8080/connect",
    accountId: transcriptTicket.accountId,
    ownerAccountId: transcriptTicket.ownerAccountId,
    accessMode: transcriptTicket.accessMode,
    accessRoleId: transcriptTicket.accessRoleId,
    deviceSessionId: transcriptTicket.deviceSessionId,
    controlPlaneId: transcriptTicket.controlPlaneId,
    bindingId: transcriptTicket.bindingId,
    bindingRevision: transcriptTicket.bindingRevision,
    targetPublicKeyFingerprint: fingerprint,
    clientProofPublicKey: "b".repeat(43),
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: transcriptTicket,
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(86),
  } as const;
  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: "task-handoff:relay-control-plane-attach", allocationId: grant.allocationId, relayId: grant.relayId, role: "control-plane", controlPlaneId: grant.controlPlaneId, accountId: grant.accountId, ownerAccountId: grant.ownerAccountId, accessMode: grant.accessMode, accessRoleId: grant.accessRoleId, deviceSessionId: grant.deviceSessionId, bindingId: grant.bindingId, ticketId: grant.accessTicketId, bindingRevision: grant.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt, expiresAt: new Date(now + 8 * 60_000).toISOString(), signature: "s".repeat(32) };
  const connector = new CloudRelayConnector({
    identity: {
      acceptCloudAccessHandshake: () => ({ response: {}, transcript: "transcript", signature: "s".repeat(32) }),
      publicIdentity: () => ({ publicKey: "c".repeat(43) }),
      signRelayRoleProof: (payload: Record<string, unknown>) => ({ ...payload, signature: "s".repeat(86) }),
    },
    bridge: { request: async () => ({ status: 200 }) } as any,
    webSocket: HangingSocket as any,
    attachTimeoutMs: 25,
  });

  const startedAt = Date.now();
  await assert.rejects(() => connector.connect({ relayUrl: grant.relayUrl, allocation: { attach, grant } }), { code: "RELAY_ATTACH_TIMEOUT" });
  assert.ok(Date.now() - startedAt >= 20, "the attach wait must be bounded by the configured timeout");
  assert.equal(sockets[0].readyState, HangingSocket.CLOSED);
});

test("relay connector bounds the encrypted handshake wait", { timeout: 2_000 }, async () => {
  let disconnected = false;
  let closeCode: number | undefined;
  class AttachOnlySocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = AttachOnlySocket.CONNECTING;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    constructor(url: string) {
      (this as any).url = url;
      queueMicrotask(() => { this.readyState = AttachOnlySocket.OPEN; this.emit("open"); });
    }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    once(event: string, listener: (...args: any[]) => void) { const wrapper = (...args: any[]) => { this.off(event, wrapper); listener(...args); }; this.on(event, wrapper); }
    off(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener)); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    send(raw: string) {
      if (JSON.parse(raw).type !== "attach") return;
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
        type: "attached",
        channelId: "channel_a",
        allocationId: "allocation_a",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })), false));
    }
    close(code?: number, reason?: string) {
      closeCode = code;
      this.readyState = AttachOnlySocket.CLOSED;
      queueMicrotask(() => this.emit("close", code, reason));
    }
    ping() {}
    terminate() { this.close(1006, "terminated"); }
  }

  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_a",
    accountId: "account_a",
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "t".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "relay_session_a",
    grantId: "grant_a",
    generation: 1,
    allocationId: "allocation_a",
    accessTicketId: "access_ticket_a",
    relayId: "relay_a",
    relayRegion: "eu-west",
    relayUrl: "ws://localhost:8080/connect",
    accountId: transcriptTicket.accountId,
    ownerAccountId: transcriptTicket.ownerAccountId,
    accessMode: transcriptTicket.accessMode,
    accessRoleId: transcriptTicket.accessRoleId,
    deviceSessionId: transcriptTicket.deviceSessionId,
    controlPlaneId: transcriptTicket.controlPlaneId,
    bindingId: transcriptTicket.bindingId,
    bindingRevision: transcriptTicket.bindingRevision,
    targetPublicKeyFingerprint: fingerprint,
    clientProofPublicKey: "b".repeat(43),
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: transcriptTicket,
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(86),
  } as const;
  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: "task-handoff:relay-control-plane-attach", allocationId: grant.allocationId, relayId: grant.relayId, role: "control-plane", controlPlaneId: grant.controlPlaneId, accountId: grant.accountId, ownerAccountId: grant.ownerAccountId, accessMode: grant.accessMode, accessRoleId: grant.accessRoleId, deviceSessionId: grant.deviceSessionId, bindingId: grant.bindingId, ticketId: grant.accessTicketId, bindingRevision: grant.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt, expiresAt: new Date(now + 8 * 60_000).toISOString(), signature: "s".repeat(32) };
  const connector = new CloudRelayConnector({
    identity: {
      acceptCloudAccessHandshake: () => ({ response: {}, transcript: "transcript", signature: "s".repeat(32) }),
      publicIdentity: () => ({ publicKey: "c".repeat(43) }),
      signRelayRoleProof: (payload: Record<string, unknown>) => ({ ...payload, signature: "s".repeat(86) }),
    },
    bridge: { request: async () => ({ status: 200 }) } as any,
    webSocket: AttachOnlySocket as any,
    attachTimeoutMs: 100,
    handshakeTimeoutMs: 25,
  });

  // The connection object is returned once attach succeeds; the encrypted
  // handshake continues in the background and must still be time-bounded.
  await connector.connect({ relayUrl: grant.relayUrl, allocation: { attach, grant }, onDisconnected: () => { disconnected = true; } });
  await waitFor(() => disconnected, 500);
  assert.equal(closeCode, 4400);
});
