import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CloudCoordinatorConnector } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import { CloudNodeRelayConnector } from "../src/control-plane/cloud-connectivity/node-relay-connector.ts";

class FakeControlSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeControlSocket.OPEN;
  readonly sent: any[] = [];
  readonly registerAutomatically: boolean;

  constructor(_url: string, _options?: unknown, registerAutomatically = false) {
    super();
    this.registerAutomatically = registerAutomatically;
    if (registerAutomatically) queueMicrotask(() => this.emit("open"));
  }

  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === "register" && this.registerAutomatically) {
      queueMicrotask(() => this.receive({
        type: "registered",
        controlPlaneId: "control_plane_test",
        reportedControlPlaneId: "control_plane_test",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
    }
  }

  terminate() { this.finish(); }
  close() { this.finish(); }
  receive(value: unknown) { this.emit("message", { toString: () => JSON.stringify(value) }); }
  private finish() {
    if (this.readyState === FakeControlSocket.CLOSED) return;
    this.readyState = FakeControlSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1006, Buffer.from("")));
  }
}

class FakeRelaySocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeRelaySocket.OPEN;

  constructor(_url: string, _options?: unknown) {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(raw: string) {
    if (JSON.parse(raw).type === "attach") {
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "attached", channelId: "relay_channel" }))));
    }
  }

  close() {
    if (this.readyState === FakeRelaySocket.CLOSED) return;
    this.readyState = FakeRelaySocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1000, Buffer.from("")));
  }
}

function controlConnector(Socket: typeof FakeControlSocket, timeouts?: { registrationTimeoutMs?: number; requestTimeoutMs?: number }) {
  return new CloudCoordinatorConnector({
    identity: {
      publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "public-key", fingerprint: "sha256:fingerprint" }),
      signCloudOutboundRegistration: () => "signature",
    } as any,
    onDisconnected: () => undefined,
    onRegistered: () => undefined,
    onRequest: async () => ({}),
    webSocket: Socket as any,
    ...timeouts,
  });
}

function connectInput() {
  return {
    serviceOrigin: "https://cloud.example.test",
    processInstanceId: "process_test",
    scopes: { deviceAccess: true, nodeRelay: true },
    epoch: 1,
    credential: "credential",
    onEvent: () => undefined,
  };
}

test("a Coordinator socket that never registers is closed and fails instead of hanging forever", async () => {
  const connector = controlConnector(FakeControlSocket, { registrationTimeoutMs: 25 });
  await assert.rejects(
    () => connector.connect(connectInput()),
    { code: "CLOUD_CONTROL_REGISTRATION_TIMEOUT", retryable: true },
  );
});

test("an acknowledged Control Plane request times out when its response is lost", async () => {
  class RegisteredSocket extends FakeControlSocket {
    constructor(url: string, options?: unknown) { super(url, options, true); }
  }
  const connector = controlConnector(RegisteredSocket, { registrationTimeoutMs: 100, requestTimeoutMs: 25 });
  const connection = await connector.connect(connectInput());

  await assert.rejects(
    () => connector.request("claim-node-relay-node", { nodeHandle: "nrh_test" }),
    { code: "CLOUD_CONTROL_REQUEST_TIMEOUT", retryable: true },
  );
  await connection.close("test-complete");
});

test("structured Control Plane RPC failures retain conflict status and details", async () => {
  const details = {
    removedRoleIds: ["role_operator"],
    roles: [{ roleId: "role_operator", owner: false, activeShareCount: 1, grantees: [{ accountId: "account_grantee" }], truncated: false }],
  };
  class RejectingSocket extends FakeControlSocket {
    constructor(url: string, options?: unknown) { super(url, options, true); }
    send(raw: string) {
      super.send(raw);
      const message = JSON.parse(raw);
      if (message.type !== "request") return;
      queueMicrotask(() => this.receive({
        type: "response",
        requestId: message.requestId,
        error: {
          code: "CONTROL_PLANE_ACCESS_ROLE_IN_USE",
          message: "Control Plane request could not be completed.",
          statusCode: 409,
          retryable: false,
          details,
        },
      }));
    }
  }
  const connector = controlConnector(RejectingSocket, { registrationTimeoutMs: 100, requestTimeoutMs: 100 });
  const connection = await connector.connect(connectInput());

  await assert.rejects(
    () => connector.request("update-control-plane-available-roles", {
      bindingId: "binding_test",
      expectedSettingsRevision: 3,
      availableRoleIds: ["role_admin", "role_viewer"],
    }),
    (error: any) => {
      assert.equal(error.code, "CONTROL_PLANE_ACCESS_ROLE_IN_USE");
      assert.equal(error.statusCode, 409);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, details);
      return true;
    },
  );
  await connection.close("test-complete");
});

test("available-role changes are refused without a live Control Plane connection", async () => {
  const connector = controlConnector(FakeControlSocket);
  await assert.rejects(
    () => connector.request("update-control-plane-available-roles", {
      bindingId: "binding_test",
      expectedSettingsRevision: 3,
      availableRoleIds: ["role_admin", "role_viewer"],
    }),
    { code: "CLOUD_CONTROL_CONNECTION_UNAVAILABLE" },
  );
});

test("a Relay attach whose handshake never arrives times out and is retryable", async () => {
  const connector = new CloudNodeRelayConnector({
    identity: {
      publicIdentity: () => ({ publicKey: "control-plane-public-key" }),
      signNodeRelayHandshake: () => "signature",
    } as any,
    webSocket: FakeRelaySocket as any,
    attachTimeoutMs: 100,
    handshakeTimeoutMs: 25,
  });

  await assert.rejects(() => connector.connect({
    allocation: {
      allocationId: "nal_test",
      relayUrl: "wss://cloud.example.test/connect",
      epoch: 1,
      channelKind: "node",
      attach: { channelKind: "node", role: "control-plane" },
      event: {
        allocationId: "nal_test",
        relayId: "relay_test",
        nodeHandle: "nrh_test",
        controlPlaneId: "control_plane_test",
        accountId: "account_test",
        bindingId: "binding_test",
        bindingRevision: 1,
      },
      nodeHandle: "nrh_test",
      nodePublicKeyFingerprint: "sha256:fingerprint",
    },
    serviceOrigin: "https://cloud.example.test",
    createPairing: () => ({ keyId: "pairing", secret: "secret" }),
  }), { code: "NODE_RELAY_HANDSHAKE_TIMEOUT", retryable: true });
});

test("closing a Relay socket that never opened does not become an uncaught error", { timeout: 1_000 }, async () => {
  class UnopenedRelaySocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = UnopenedRelaySocket.CONNECTING;
    closeCalls = 0;

    close() {
      this.closeCalls += 1;
      this.readyState = UnopenedRelaySocket.CLOSED;
      queueMicrotask(() => {
        this.emit("error", new Error("WebSocket was closed before the connection was established"));
        this.emit("close", 1006, Buffer.from(""));
      });
    }
  }

  const sockets: UnopenedRelaySocket[] = [];
  class CapturingSocket extends UnopenedRelaySocket {
    constructor() { super(); sockets.push(this); }
  }
  const connector = new CloudNodeRelayConnector({
    identity: {
      publicIdentity: () => ({ publicKey: "control-plane-public-key" }),
      signNodeRelayHandshake: () => "signature",
    } as any,
    webSocket: CapturingSocket as any,
    attachTimeoutMs: 20,
  });

  await assert.rejects(() => connector.connect({
    allocation: {
      allocationId: "nal_test",
      relayUrl: "wss://cloud.example.test/connect",
      epoch: 1,
      channelKind: "node",
      attach: { channelKind: "node", role: "control-plane" },
      event: {
        allocationId: "nal_test",
        relayId: "relay_test",
        nodeHandle: "nrh_test",
        controlPlaneId: "control_plane_test",
        accountId: "account_test",
        bindingId: "binding_test",
        bindingRevision: 1,
      },
      nodeHandle: "nrh_test",
      nodePublicKeyFingerprint: "sha256:fingerprint",
    },
    serviceOrigin: "https://cloud.example.test",
    createPairing: () => ({ keyId: "pairing", secret: "secret" }),
  }), { code: "NODE_RELAY_ATTACH_TIMEOUT", retryable: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets[0]?.closeCalls, 1);
});
