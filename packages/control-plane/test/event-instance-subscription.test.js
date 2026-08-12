import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";

function socket() {
  const listeners = {};
  const sent = [];
  return {
    listeners,
    sent,
    value: {
      readyState: 1,
      OPEN: 1,
      send: (value) => sent.push(JSON.parse(value)),
      on: (event, listener) => { listeners[event] = listener; },
    },
  };
}

test("event bus preserves v0.0.21 all-instance behavior when no scope is requested", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  events.publish("instance.updated", {}, { scope: { instanceId: "a" } });
  events.publish("instance.updated", {}, { scope: { instanceId: "b" } });
  assert.deepEqual(client.sent.map((event) => event.scope.instanceId), ["a", "b"]);
});

test("event bus combines topic and optional instance subscription filters", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value);
  client.listeners.message(JSON.stringify({ type: "subscribe", topics: ["instances"], instanceIds: ["a"] }));
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "a" } });
  events.publish("instance.updated", {}, { topic: "instances", scope: { instanceId: "b" } });
  events.publish("project.updated", {}, { topic: "projects" });
  assert.deepEqual(client.sent.map((event) => event.scope.instanceId), ["a"]);
});

test("global events without instance scope remain visible to scoped clients", () => {
  const events = new ControlPlaneEventBus();
  const client = socket();
  events.connect(client.value, { instanceIds: ["a"] });
  events.publish("system.updated", {}, { topic: "system" });
  assert.equal(client.sent.length, 1);
});
