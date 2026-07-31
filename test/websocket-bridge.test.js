const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { bridgeWebSockets, closeWebSocket } = require("../packages/protocol/src/websocket-bridge.ts");

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.closes = [];
  }

  send() {}

  close(code, reason) {
    if (code !== undefined && !isSendableCloseCode(code)) {
      throw new TypeError("First argument must be a valid error code number");
    }
    if (reason !== undefined && Buffer.byteLength(reason, "utf8") > 123) {
      throw new RangeError("The message must not be greater than 123 bytes");
    }
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

function isSendableCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
}

test("bridgeWebSockets does not forward non-sendable websocket close codes", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();

  bridgeWebSockets(client, upstream);
  upstream.emit("close", 1006, "abnormal close");

  assert.deepEqual(client.closes, [{ code: undefined, reason: "abnormal close" }]);
});

test("bridgeWebSockets truncates overlong close reasons before forwarding", () => {
  const client = new MockWebSocket();
  const upstream = new MockWebSocket();

  bridgeWebSockets(client, upstream);
  upstream.emit("close", 1011, "x".repeat(200));

  assert.equal(client.closes.length, 1);
  assert.equal(client.closes[0].code, 1011);
  assert.equal(Buffer.byteLength(client.closes[0].reason, "utf8"), 123);
});

test("closeWebSocket normalizes runtime close events before forwarding them", () => {
  const socket = new MockWebSocket();

  closeWebSocket(socket, 1006, "x".repeat(200));

  assert.equal(socket.closes.length, 1);
  assert.equal(socket.closes[0].code, undefined);
  assert.equal(Buffer.byteLength(socket.closes[0].reason, "utf8"), 123);
});
