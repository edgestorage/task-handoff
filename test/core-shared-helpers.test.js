const assert = require("node:assert/strict");
const test = require("node:test");

const { safeFileName } = require("../packages/core/src/core/file-names.ts");
const { PROXY_HOP_BY_HOP_HEADERS, proxyWebSocketHeaders, proxyWebSocketProtocols } = require("../packages/core/src/core/http-proxy.ts");
const { processStartIdentity } = require("../packages/core/src/core/process-singleton-lock.ts");
const processIdentityModule = require("../shared/process-start-identity.cjs");

test("process start identity has one implementation for core and Desktop", () => {
  assert.equal(processStartIdentity, processIdentityModule.processStartIdentity);
  assert.equal(processStartIdentity(0), undefined);
  assert.equal(processStartIdentity(process.pid, "android"), undefined);
});

test("safe file names normalize both path separator styles and retain unicode names", () => {
  assert.equal(safeFileName("../../folder/报告 1.pdf"), "报告 1.pdf");
  assert.equal(safeFileName("..\\folder\\asset\u0000.bin"), "asset_.bin");
  assert.equal(safeFileName("report:final?.png"), "report_final_.png");
  assert.equal(safeFileName("CON.txt"), "_CON.txt");
  assert.equal(safeFileName("   "), "attachment");
  assert.equal(safeFileName("x".repeat(300)).length, 240);
  const boundedUnicode = safeFileName("报告".repeat(120), "attachment", { maxBytes: 20 });
  assert.ok(Buffer.byteLength(boundedUnicode) <= 20);
  assert.equal(boundedUnicode.includes("�"), false);
});

test("proxy helpers share hop-by-hop filtering and websocket handshake normalization", () => {
  assert.equal(PROXY_HOP_BY_HOP_HEADERS.has("transfer-encoding"), true);
  assert.deepEqual(proxyWebSocketProtocols({ "Sec-WebSocket-Protocol": [" chat, binary ", "chat"] }), ["chat", "binary", "chat"]);
  assert.deepEqual(proxyWebSocketHeaders({
    host: "runtime.local",
    "sec-websocket-key": "secret",
    "sec-websocket-origin": "https://control.local",
    "x-trace-id": "trace",
  }, { blockedHeaders: new Set(["host"]) }), {
    "sec-websocket-origin": "https://control.local",
    "x-trace-id": "trace",
  });
});
