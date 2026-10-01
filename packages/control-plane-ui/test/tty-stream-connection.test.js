import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { TtyStreamConnection } from "../src/apps/control-plane/ttyStreamConnection.ts";

const source = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

class FakeSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.binaryType = "blob";
    this.sent = [];
    this.closeCalls = [];
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  drop() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }
}

function createHarness() {
  const sockets = [];
  const timers = new Map();
  const disconnects = [];
  const messages = [];
  let nextTimerId = 0;
  const connection = new TtyStreamConnection({
    url: "ws://control-plane.test/instances/inst/tty",
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    setTimeoutFn: (callback, delay) => {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    handlers: {
      onMessage: (event) => messages.push(event.data),
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    },
  });
  return {
    connection,
    disconnects,
    messages,
    sockets,
    pendingDelays: () => [...timers.values()].map((timer) => timer.delay),
    runNextRetry() {
      const next = timers.entries().next();
      if (next.done) return undefined;
      timers.delete(next.value[0]);
      next.value[1].callback();
      return next.value[1].delay;
    },
  };
}

test("a TTY stream reconnects immediately and then backs off through the shared retry policy", () => {
  const harness = createHarness();
  harness.connection.start();
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.sockets[0].url, "ws://control-plane.test/instances/inst/tty");
  assert.equal(harness.sockets[0].binaryType, "arraybuffer");

  harness.sockets[0].drop();
  assert.deepEqual(harness.disconnects, [{ attempt: 1, delayMs: 0 }]);
  assert.deepEqual(harness.pendingDelays(), [0]);
  assert.equal(harness.runNextRetry(), 0);
  assert.equal(harness.sockets.length, 2);

  harness.sockets[1].drop();
  assert.deepEqual(harness.disconnects[1], { attempt: 2, delayMs: 250 });
  assert.equal(harness.runNextRetry(), 250);
  assert.equal(harness.sockets.length, 3);

  harness.sockets[2].drop();
  assert.deepEqual(harness.disconnects[2], { attempt: 3, delayMs: 500 });
});

test("a reopened TTY stream resets the reconnect backoff", () => {
  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();
  assert.equal(harness.connection.connected, true);
  harness.sockets[0].drop();
  harness.runNextRetry();
  harness.sockets[1].open();
  harness.sockets[1].drop();
  assert.deepEqual(harness.disconnects, [{ attempt: 1, delayMs: 0 }, { attempt: 1, delayMs: 0 }]);
  assert.deepEqual(harness.pendingDelays(), [0]);
});

test("stopping a TTY stream cancels retries and closes the live socket", () => {
  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();
  harness.connection.send({ type: "input", data: "ls\r" });
  assert.deepEqual(harness.sockets[0].sent, ['{"type":"input","data":"ls\\r"}']);

  harness.connection.stop();
  assert.deepEqual(harness.sockets[0].closeCalls, [{ code: 1000, reason: "Client closed" }]);
  assert.equal(harness.connection.connected, false);
  assert.equal(harness.connection.send({ type: "input", data: "x" }), false);

  const dropped = createHarness();
  dropped.connection.start();
  dropped.sockets[0].open();
  dropped.sockets[0].drop();
  assert.deepEqual(dropped.pendingDelays(), [0]);
  dropped.connection.stop();
  assert.deepEqual(dropped.pendingDelays(), []);
  assert.equal(dropped.runNextRetry(), undefined);
  assert.equal(dropped.sockets.length, 1);
});

test("stale socket events cannot reconnect or deliver output twice", () => {
  const harness = createHarness();
  harness.connection.start();
  const first = harness.sockets[0];
  first.open();
  first.drop();
  harness.runNextRetry();
  const second = harness.sockets[1];
  second.open();
  assert.equal(harness.sockets.length, 2);

  first.drop();
  first.receive("stale");
  second.receive("live");
  assert.deepEqual(harness.pendingDelays(), []);
  assert.deepEqual(harness.messages, ["live"]);
  assert.equal(harness.connection.send({ type: "resize", cols: 120, rows: 32 }), true);
  assert.deepEqual(second.sent, ['{"type":"resize","cols":120,"rows":32}']);
});

test("a failed socket construction is retried like a dropped stream", () => {
  const timers = [];
  const sockets = [];
  let attempts = 0;
  const connection = new TtyStreamConnection({
    url: "ws://control-plane.test/instances/inst/tty",
    createSocket: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("WebSocket constructor rejected the URL");
      const socket = new FakeSocket("ws://control-plane.test/instances/inst/tty");
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
    handlers: { onMessage() {}, onDisconnect: () => undefined },
  });

  connection.start();
  assert.equal(attempts, 1);
  assert.deepEqual(timers.map((timer) => timer.delay), [0]);
  assert.equal(connection.connected, false);
  timers.shift().callback();
  assert.equal(attempts, 2);
  sockets[0].open();
  assert.equal(connection.connected, true);
});

test("every control-plane TTY surface reconnects through the shared stream connection", () => {
  const surfaces = [
    "apps/control-plane/useTerminalPreview.ts",
    "apps/control-plane/board/useBoardTerminalPreviews.ts",
    "apps/control-plane/app-access/AppAccessView.vue",
  ];
  for (const path of surfaces) {
    const content = source(path);
    assert.match(content, /TtyStreamConnection/, path);
    assert.doesNotMatch(content, /new WebSocket\(/, path);
    assert.match(content, /\.stop\(\)/, path);
  }
});
