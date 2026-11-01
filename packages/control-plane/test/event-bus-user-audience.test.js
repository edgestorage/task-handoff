import assert from "node:assert/strict";
import test from "node:test";

import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";

function socket() {
  const listeners = new Map();
  const frames = [];
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    frames,
    send(value) { frames.push(JSON.parse(value)); },
    close() { this.readyState = 3; },
    on(type, listener) { listeners.set(type, listener); },
    emit(type, value) {
      if (type === "message") listeners.get(type)?.({ toString: () => value });
      else listeners.get(type)?.(value);
    },
  };
}

function subscribe(target, topics = ["operation.approvals"]) {
  target.emit("message", JSON.stringify({ v: 1, type: "subscribe", topics }));
}

test("operation events reach every authenticated administrator and exclude non-admins", () => {
  const bus = new ControlPlaneEventBus();
  const web = socket();
  const mobile = socket();
  const otherAdmin = socket();
  const nonAdmin = socket();
  const unauthenticated = socket();
  bus.connect(web, { authorization: {
    userId: "usr_admin_a",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(mobile, { authorization: {
    userId: "usr_admin_a",
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(otherAdmin, { authorization: {
    userId: "usr_admin_b",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(nonAdmin, { authorization: {
    userId: "usr_viewer",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["instances:read"],
  } });
  bus.connect(unauthenticated);
  for (const target of [web, mobile, otherAdmin, nonAdmin, unauthenticated]) subscribe(target);

  bus.publish("operation-approval.changed", { request: { id: "apr_1" }, status: "pending", revision: 1 }, {
    topic: "operation.approvals",
  });

  assert.equal(web.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(mobile.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherAdmin.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(nonAdmin.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
  assert.equal(unauthenticated.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
});


test("authorization invalidation removes stale administrator sockets before later operation events", () => {
  const bus = new ControlPlaneEventBus();
  const staleMobile = socket();
  const currentWeb = socket();
  const otherUser = socket();
  bus.connect(staleMobile, { authorization: {
    userId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(currentWeb, { authorization: {
    userId: "usr_owner",
    webSession: true,
    authorizationRevision: 2,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(otherUser, { authorization: {
    userId: "usr_other",
    authorizationRevision: 2,
    permissionIds: ["settings:manage"],
  } });
  for (const target of [staleMobile, currentWeb, otherUser]) subscribe(target);

  bus.invalidateUserAuthorization("usr_owner", 2);
  bus.publish("operation-approval.changed", { request: { id: "apr_2" }, status: "pending", revision: 2 }, {
    topic: "operation.approvals",
  });

  assert.equal(staleMobile.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
  assert.equal(currentWeb.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherUser.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
});

test("operation events require administrator permission on a Cloud event binding", () => {
  const bus = new ControlPlaneEventBus();
  const mapped = socket();
  const unmapped = socket();
  const otherOwner = socket();
  bus.connect(mapped, { authorization: {
    userId: "cloud-account:acct_owner",
    ownerUserId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(unmapped, { authorization: {
    userId: "cloud-account:acct_unmapped",
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(otherOwner, { authorization: {
    userId: "cloud-account:acct_other",
    ownerUserId: "usr_other",
    authorizationRevision: 1,
    permissionIds: ["instances:read"],
  } });
  for (const target of [mapped, unmapped, otherOwner]) subscribe(target);

  bus.publish("operation-approval.changed", { request: { id: "apr_cloud" }, status: "pending", revision: 1 }, {
    topic: "operation.approvals",
  });

  assert.equal(mapped.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(unmapped.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherOwner.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
});

test("cloud node relay events require settings management permission", () => {
  const bus = new ControlPlaneEventBus();
  const admin = socket();
  const viewer = socket();
  const unauthenticated = socket();
  bus.connect(admin, { authorization: {
    userId: "usr_admin",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(viewer, { authorization: {
    userId: "usr_viewer",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["nodes:read"],
  } });
  bus.connect(unauthenticated);
  for (const target of [admin, viewer, unauthenticated]) subscribe(target, ["cloud-node-relay"]);

  bus.publish("cloud-node-relay.changed", { revision: 1, reason: "channel-attached" }, {
    topic: "cloud-node-relay",
  });

  assert.equal(admin.frames.filter((frame) => frame.type === "cloud-node-relay.changed").length, 1);
  assert.equal(viewer.frames.filter((frame) => frame.type === "cloud-node-relay.changed").length, 0);
  assert.equal(unauthenticated.frames.filter((frame) => frame.type === "cloud-node-relay.changed").length, 0);
});

test("node Control Plane trust events require settings management permission", () => {
  const bus = new ControlPlaneEventBus();
  const admin = socket();
  const viewer = socket();
  const unauthenticated = socket();
  bus.connect(admin, { authorization: {
    userId: "usr_admin",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["settings:manage"],
  } });
  bus.connect(viewer, { authorization: {
    userId: "usr_viewer",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: ["nodes:read"],
  } });
  bus.connect(unauthenticated);
  for (const target of [admin, viewer, unauthenticated]) subscribe(target, ["nodes"]);

  bus.publish("node.control-plane-trust.changed", {
    nodeId: "node_a",
    controlPlaneId: "control_plane_a",
    requestId: "cptreq_a",
    state: "pending",
  }, {
    topic: "nodes",
    scope: { nodeId: "node_a" },
  });

  assert.equal(admin.frames.filter((frame) => frame.type === "node.control-plane-trust.changed").length, 1);
  assert.equal(viewer.frames.filter((frame) => frame.type === "node.control-plane-trust.changed").length, 0);
  assert.equal(unauthenticated.frames.filter((frame) => frame.type === "node.control-plane-trust.changed").length, 0);
});

test("an audience-scoped bridge listener receives public and matching personal events", () => {
  const bus = new ControlPlaneEventBus();
  const publicEvents = [];
  const ownerEvents = [];
  const otherEvents = [];
  bus.on((event) => publicEvents.push(event.type));
  bus.on((event) => ownerEvents.push(event.type), { audienceUserId: "usr_owner" });
  bus.on((event) => otherEvents.push(event.type), { audienceUserId: "usr_other" });

  bus.publish("instance.updated", { id: "instance_a" }, { topic: "instances" });
  bus.publish("operation-approval.changed", { request: { id: "apr_owner" } }, { topic: "operation.approvals", audienceUserId: "usr_owner" });

  assert.deepEqual(publicEvents, ["instance.updated"]);
  assert.deepEqual(ownerEvents, ["instance.updated", "operation-approval.changed"]);
  assert.deepEqual(otherEvents, ["instance.updated"]);
});

test("authorization invalidation removes a stale audience-scoped bridge listener", () => {
  const bus = new ControlPlaneEventBus();
  const events = [];
  bus.on((event) => events.push(event.type), { audienceUserId: "usr_owner", authorizationRevision: 1 });

  bus.invalidateUserAuthorization("usr_owner", 2);
  bus.publish("operation-approval.changed", { request: { id: "apr_stale" } }, { topic: "operation.approvals", audienceUserId: "usr_owner" });

  assert.deepEqual(events, []);
});
