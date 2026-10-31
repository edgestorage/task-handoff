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

function subscribe(target) {
  target.emit("message", JSON.stringify({ v: 1, type: "subscribe", topics: ["operation.approvals"] }));
}

test("user-targeted operation events reach authenticated mobile and Web sessions only for that user", () => {
  const bus = new ControlPlaneEventBus();
  const web = socket();
  const mobile = socket();
  const secondMobile = socket();
  const otherUser = socket();
  const unauthenticated = socket();
  bus.connect(web, { authorization: {
    userId: "usr_owner",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(mobile, { authorization: {
    userId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(secondMobile, { authorization: {
    userId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(otherUser, { authorization: {
    userId: "usr_other",
    webSession: true,
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(unauthenticated);
  for (const target of [web, mobile, secondMobile, otherUser, unauthenticated]) subscribe(target);

  bus.publish("operation-approval.changed", { request: { id: "apr_1" }, status: "pending", revision: 1 }, {
    topic: "operation.approvals",
    audienceUserId: "usr_owner",
  });

  assert.equal(web.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(mobile.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(secondMobile.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherUser.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
  assert.equal(unauthenticated.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
});


test("authorization invalidation removes stale owner sockets before later operation events", () => {
  const bus = new ControlPlaneEventBus();
  const staleMobile = socket();
  const currentWeb = socket();
  const otherUser = socket();
  bus.connect(staleMobile, { authorization: {
    userId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(currentWeb, { authorization: {
    userId: "usr_owner",
    webSession: true,
    authorizationRevision: 2,
    permissionIds: [],
  } });
  bus.connect(otherUser, { authorization: {
    userId: "usr_other",
    authorizationRevision: 2,
    permissionIds: [],
  } });
  for (const target of [staleMobile, currentWeb, otherUser]) subscribe(target);

  bus.invalidateUserAuthorization("usr_owner", 2);
  bus.publish("operation-approval.changed", { request: { id: "apr_2" }, status: "pending", revision: 2 }, {
    topic: "operation.approvals",
    audienceUserId: "usr_owner",
  });

  assert.equal(staleMobile.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
  assert.equal(currentWeb.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherUser.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
});

test("an owner Cloud session can receive only its mapped user's operation approvals", () => {
  const bus = new ControlPlaneEventBus();
  const mapped = socket();
  const unmapped = socket();
  const otherOwner = socket();
  bus.connect(mapped, { authorization: {
    userId: "cloud-account:acct_owner",
    ownerUserId: "usr_owner",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(unmapped, { authorization: {
    userId: "cloud-account:acct_unmapped",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  bus.connect(otherOwner, { authorization: {
    userId: "cloud-account:acct_other",
    ownerUserId: "usr_other",
    authorizationRevision: 1,
    permissionIds: [],
  } });
  for (const target of [mapped, unmapped, otherOwner]) subscribe(target);

  bus.publish("operation-approval.changed", { request: { id: "apr_cloud" }, status: "pending", revision: 1 }, {
    topic: "operation.approvals",
    audienceUserId: "usr_owner",
  });

  assert.equal(mapped.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(unmapped.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
  assert.equal(otherOwner.frames.filter((frame) => frame.type === "operation-approval.changed").length, 0);
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
