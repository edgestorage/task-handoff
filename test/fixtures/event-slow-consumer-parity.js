const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
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

const EVENT_TYPE = "parity.slow-consumer";
const FIXED_NOW = Date.parse("2026-11-20T00:00:00.000Z");
const MAX_EVENT_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const STABLE_RANDOM = 0.123456789012345;

function withStableEventIds(callback) {
  const random = Math.random;
  Math.random = () => STABLE_RANDOM;
  try {
    return callback();
  } finally {
    Math.random = random;
  }
}

function frameBytesForFiller(fillerBytes) {
  let encoded;
  const bus = new WebEventBus(() => FIXED_NOW);
  bus.connect({
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send(value) { encoded = value; },
    on() {},
  });
  bus.publish(EVENT_TYPE, { filler: "x".repeat(fillerBytes) });
  assert.equal(typeof encoded, "string");
  return Buffer.byteLength(encoded, "utf8");
}

function payloadForFrameBytes(frameBytes) {
  return withStableEventIds(() => {
    const fillerBytes = frameBytes - frameBytesForFiller(0);
    assert.ok(fillerBytes >= 0, `frame size ${frameBytes} is smaller than the envelope`);
    if (frameBytes <= MAX_EVENT_CLIENT_BUFFERED_BYTES) {
      assert.equal(frameBytesForFiller(fillerBytes), frameBytes);
    }
    return "x".repeat(fillerBytes);
  });
}

function slowConsumer() {
  const sent = [];
  const closes = [];
  const value = {
    readyState: 1,
    OPEN: 1,
    sentBytes: 0,
    get bufferedAmount() { return this.sentBytes; },
    send(encoded) {
      sent.push(encoded);
      this.sentBytes += Buffer.byteLength(encoded, "utf8");
    },
    on() {},
    close(code, reason) {
      closes.push({ code, reason });
      this.readyState = 3;
    },
  };
  return { value, sent, closes };
}

function observeNodeEventSlowConsumer(scenario) {
  const client = slowConsumer();
  withStableEventIds(() => {
    const bus = new WebEventBus(() => FIXED_NOW);
    bus.connect(client.value);
    bus.publish(EVENT_TYPE, { filler: payloadForFrameBytes(scenario.frameBytes) });
    if (scenario.expected.close) bus.publish(EVENT_TYPE, { marker: "after-close" });
  });
  const deliveredBytes = client.sent.reduce((total, encoded) => total + Buffer.byteLength(encoded, "utf8"), 0);
  return {
    delivered: client.sent.length,
    deliveredBytes,
    close: client.closes[0] || null,
    afterCloseDelivered: client.sent.filter((encoded) => JSON.parse(encoded).payload.marker === "after-close").length,
  };
}

module.exports = { observeNodeEventSlowConsumer };
