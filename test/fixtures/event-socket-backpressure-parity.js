const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const ts = require("typescript");
const { WebSocket, WebSocketServer } = require("ws");
const { registerWorkspaceRequire } = require("../workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { WebEventBus } = require("../../packages/controlled-instance/src/web/events.ts");

const EVENT_TYPE = "parity.socket-backpressure";

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(
    __dirname,
    "../../controlled-instance-rs/crates/instance/tests/fixtures/event-socket-backpressure-parity.json",
  ), "utf8"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitClose(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("backpressure close timeout")), timeoutMs);
    client.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    client.once("error", reject);
  });
}

function assertBackpressure(result, scenario) {
  const expected = scenario.expected;
  assert.deepEqual(result.close, expected.close);
  assert.ok(result.deliveredFrames >= expected.deliveredFramesAtLeast);
  if (expected.deliveredFramesBelowFrameCount) {
    assert.ok(result.deliveredFrames < scenario.frameCount);
  }
  assert.ok(result.deliveredPayloadBytes <= expected.deliveredPayloadBytesAtMost);
  assert.equal(result.afterCloseDelivered, expected.afterCloseDelivered);
}

async function observeNodeEventSocketBackpressure() {
  const scenario = fixture().scenario;
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
  let client;
  try {
    const port = await listen(server);
    client = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 64 * 1024 * 1024 });
    let deliveredFrames = 0;
    let deliveredPayloadBytes = 0;
    client.on("message", (data, binary) => {
      if (binary) return;
      const text = data.toString();
      const event = JSON.parse(text);
      if (event.type !== EVENT_TYPE) return;
      deliveredFrames += 1;
      deliveredPayloadBytes += Buffer.byteLength(text, "utf8");
    });
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const socket = [...sockets.clients].find(candidate => candidate.readyState === WebSocket.OPEN);
    assert.ok(socket, "server websocket connection");
    client._socket.pause();

    const events = new WebEventBus();
    events.connect(socket);
    const filler = "x".repeat(scenario.payloadBytes);
    for (let index = 0; index < scenario.frameCount; index += 1) {
      events.publish(EVENT_TYPE, { filler });
    }
    await new Promise(resolve => setTimeout(resolve, scenario.pauseMs));
    client._socket.resume();
    const close = await waitClose(client, 10_000);
    const framesBeforeClose = deliveredFrames;
    events.publish(EVENT_TYPE, { marker: "after-close" });
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      deliveredFrames,
      deliveredPayloadBytes,
      close,
      afterCloseDelivered: deliveredFrames - framesBeforeClose,
    };
  } finally {
    client?.terminate();
    sockets.close();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { assertBackpressure, fixture, observeNodeEventSocketBackpressure };
