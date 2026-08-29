const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { BrowserSocksServer, parseSocksRequest } = require("../src/browser-socks-server.cjs");
const { partitionName } = require("../src/desktop-browser-contexts.cjs");

test("SOCKS parser supports domain, IPv4, and IPv6 CONNECT targets", () => {
  assert.deepEqual(parseSocksRequest(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x0b, 0xb8])), { command: 1, host: "127.0.0.1", port: 3000, bytes: 10 });
  const domain = Buffer.concat([Buffer.from([5, 1, 0, 3, 9]), Buffer.from("localhost"), Buffer.from([0, 80])]);
  assert.deepEqual(parseSocksRequest(domain), { command: 1, host: "localhost", port: 80, bytes: domain.length });
  const ipv6 = Buffer.from([5, 1, 0, 4, ...Buffer.alloc(15), 1, 1, 187]);
  assert.deepEqual(parseSocksRequest(ipv6), { command: 1, host: "0:0:0:0:0:0:0:1", port: 443, bytes: 22 });
});

test("SOCKS server maps a CONNECT request to one Browser Tunnel stream", async () => {
  const attached = [];
  const channel = { async attach(target, socket) { attached.push({ target, socket }); } };
  const server = new BrowserSocksServer(channel);
  const socket = new TestSocket();
  server.accept(socket);
  socket.emit("data", Buffer.from([5, 1, 0]));
  socket.emit("data", Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x0b, 0xb8]));
  await Promise.resolve();
  assert.deepEqual(attached.map((entry) => entry.target), [{ host: "127.0.0.1", port: 3000 }]);
  assert.deepEqual(socket.writes.map((entry) => [...entry]), [[5, 0], [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]]);
});

test("SOCKS server pauses application bytes until the tunnel stream opens", async () => {
  let finishAttach;
  const attached = new Promise((resolve) => { finishAttach = resolve; });
  const channel = {
    async attach(_target, socket) {
      assert.equal(socket.paused, true);
      await attached;
      socket.resume();
    },
  };
  const server = new BrowserSocksServer(channel);
  const socket = new TestSocket();
  server.accept(socket);
  socket.emit("data", Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
  assert.equal(socket.paused, true);
  finishAttach();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.at(-1)[1], 0);
  assert.equal(socket.paused, false);
});

test("browser partitions are stable per authority and isolated across instances", () => {
  assert.equal(partitionName("cp_1", "instance_1"), partitionName("cp_1", "instance_1"));
  assert.notEqual(partitionName("cp_1", "instance_1"), partitionName("cp_1", "instance_2"));
  assert.notEqual(partitionName("cp_1", "instance_1"), partitionName("cp_2", "instance_1"));
});

class TestSocket extends EventEmitter {
  writes = [];
  destroyed = false;
  paused = false;
  write(data) { this.writes.push(Buffer.from(data)); return true; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  end() { this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
