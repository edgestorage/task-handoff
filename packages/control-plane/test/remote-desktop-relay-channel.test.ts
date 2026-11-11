import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedRemoteDesktopCapabilities } from "@task-handoff/protocol/remote-desktop";
import type { ControlPlaneActor } from "../src/control-plane/auth/authorization.ts";
import { openRemoteDesktopRelayChannel } from "../src/control-plane/remote-desktop/relay-channel.ts";

const actor: ControlPlaneActor = {
  type: "cloud-account",
  accountId: "account_a",
  ownerAccountId: "account_a",
  deviceSessionId: "device_a",
  bindingId: "binding_a",
  bindingRevision: 1,
  accessMode: "owner",
  accessRoleId: "role_owner",
  roleIds: ["role_owner"],
  permissionIds: ["instances:interactive"],
  nodeScope: { kind: "all" },
  instanceScope: { kind: "inherit-node-scope" },
  authorizationRevision: 1,
};

const capabilities = {
  features: {
    remoteDesktop: {
      ...unsupportedRemoteDesktopCapabilities(),
      available: true,
      status: "ready",
    },
  },
};

function dependencies() {
  const calls: unknown[] = [];
  let socket: any;
  const access = accessFor(calls, (next) => { socket = next; });
  return {
    calls,
    get socket() { return socket; },
    dependencies: {
      service: {
        async requireControlledInstance(instanceId: string) {
          return { id: instanceId, nodeId: "node_a", capabilities };
        },
      },
      access: () => access,
    },
  };
}

function accessFor(calls: unknown[], connected: (socket: any) => void) {
  return {
    consume(_principal: unknown, instanceId: string, sessionId: string, ticket: string) {
      calls.push(["consume", instanceId, sessionId, ticket]);
      return { entry: "signal" };
    },
    consumeFallback(_principal: unknown, instanceId: string, sessionId: string, role: string, ticket: string) {
      calls.push(["consumeFallback", instanceId, sessionId, role, ticket]);
      return { entry: { entry: "fallback" }, generation: "generation_a" };
    },
    async connect(entry: any, socket: any) {
      calls.push(["connect", entry]);
      connected(socket);
    },
    async connectFallback(entry: any, role: string, generation: string, socket: any) {
      calls.push(["connectFallback", entry, role, generation]);
      connected(socket);
    },
  };
}

test("relay signal channels consume the exact ticket and bridge both directions", async () => {
  const h = dependencies();
  const received: unknown[] = [];
  const channel = await openRemoteDesktopRelayChannel(h.dependencies, actor, {
    path: "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.2026-11-11"],
  }, {
    async onMessage(message) { received.push(message); },
    onClose() {},
  });
  assert.deepEqual(h.calls[0], ["consume", "inst_a", "rdv_a", "ticket_a"]);
  assert.deepEqual(h.calls[1], ["connect", { entry: "signal" }]);
  const upstream: unknown[] = [];
  h.socket!.on("message", (...args: unknown[]) => upstream.push(args));
  await channel.send({ bytes: new TextEncoder().encode("{\"type\":\"signalAlive\"}"), binary: false });
  assert.equal((upstream[0] as unknown[])[1], false);
  assert.equal(Buffer.from((upstream[0] as unknown[])[0] as Buffer).toString(), "{\"type\":\"signalAlive\"}");
  h.socket!.send("{\"type\":\"snapshot\"}");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.length, 1);
  assert.equal((received[0] as { binary: boolean }).binary, false);
});

test("relay fallback channels preserve role, generation and one-time ticket authority", async () => {
  const h = dependencies();
  const channel = await openRemoteDesktopRelayChannel(h.dependencies, actor, {
    path: "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/fallback/media?ticket=ticket_media",
    protocols: ["taskhandoff.remote-desktop.fallback.media.v1"],
  }, {
    async onMessage() {},
    onClose() {},
  });
  assert.deepEqual(h.calls[0], ["consumeFallback", "inst_a", "rdv_a", "media", "ticket_media"]);
  assert.deepEqual(h.calls[1], ["connectFallback", { entry: "fallback" }, "media", "generation_a"]);
  assert.equal(h.socket!.readyState, 1);
  channel.close();
  assert.equal(h.socket!.readyState, 3);
});

test("relay desktop bridge rejects arbitrary paths, protocols and scopes", async () => {
  const h = dependencies();
  await assert.rejects(openRemoteDesktopRelayChannel(h.dependencies, actor, {
    path: "/api/health?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.2026-11-11"],
  }, { async onMessage() {}, onClose() {} }), { code: "REMOTE_DESKTOP_CHANNEL_PATH_INVALID" });
  await assert.rejects(openRemoteDesktopRelayChannel(h.dependencies, actor, {
    path: "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.fallback.media.v1"],
  }, { async onMessage() {}, onClose() {} }), { code: "REMOTE_DESKTOP_CHANNEL_PROTOCOL_INVALID" });
  await assert.rejects(openRemoteDesktopRelayChannel(h.dependencies, {
    ...actor,
    nodeScope: { kind: "nodes", nodeIds: ["node_other"] },
    instanceScope: { kind: "inherit-node-scope" },
  }, {
    path: "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a",
    protocols: ["taskhandoff.remote-desktop.2026-11-11"],
  }, { async onMessage() {}, onClose() {} }), { code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE" });
  assert.equal(h.calls.length, 0);
});
