import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createWebInstanceWindowCoordinator } from "../src/apps/control-plane/instance-detail/instanceWindowCoordinator.ts";

class Channel extends EventEmitter {
  static channels = new Set();
  constructor() { super(); Channel.channels.add(this); }
  addEventListener(_type, listener) { this.on("message", listener); }
  removeEventListener(_type, listener) { this.off("message", listener); }
  postMessage(data) {
    for (const channel of Channel.channels) if (channel !== this) queueMicrotask(() => channel.emit("message", { data }));
  }
  close() { Channel.channels.delete(this); }
}

function locks() {
  const held = new Set();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
}

test("web coordinator holds one lock per instance and preserves current claim on conflict", async () => {
  const manager = locks();
  let focused = 0;
  const first = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: manager, windowId: "first" });
  const second = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: manager, windowId: "second", focus: () => { focused += 1; } });
  assert.deepEqual(await first.claim("a"), { action: "claimed" });
  assert.deepEqual(await second.claim("b"), { action: "claimed" });
  assert.deepEqual(await first.claim("b"), { action: "focused", focused: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first.currentInstanceId(), "a");
  assert.equal(second.currentInstanceId(), "b");
  assert.equal(focused, 1);
  first.dispose();
  second.dispose();
});

test("web coordinator releases the old lock only after claiming the new instance", async () => {
  const manager = locks();
  const first = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: manager, windowId: "first" });
  const second = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: manager, windowId: "second" });
  assert.equal((await first.claim("a")).action, "claimed");
  assert.equal((await first.claim("b")).action, "claimed");
  assert.equal((await second.claim("a")).action, "claimed");
  first.dispose();
  second.dispose();
});

test("broadcast fallback deterministically relinquishes a simultaneous duplicate claim", async () => {
  const lost = [];
  const first = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: null, windowId: "a", focus: () => {} });
  const second = createWebInstanceWindowCoordinator({ channel: new Channel(), locks: null, windowId: "b", focus: () => {}, onOwnershipLost: (id) => lost.push(id) });
  try {
    const results = await Promise.all([first.claim("shared"), second.claim("shared")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(results.filter((result) => result.action === "claimed").length >= 1, true);
    assert.deepEqual([first.currentInstanceId(), second.currentInstanceId()].filter(Boolean), ["shared"]);
    assert.equal(results.some((result) => result.action === "focused") || lost.includes("shared"), true);
  } finally {
    first.dispose();
    second.dispose();
  }
});
