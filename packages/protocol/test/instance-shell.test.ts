import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES,
  INSTANCE_SHELL_PROTOCOL_VERSION,
  INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL,
  InstanceShellDataChannel,
  InstanceShellProtocolError,
  decodeInstanceShellBinaryFrame,
  encodeInstanceShellBinaryFrame,
  parseInstanceShellClientControlFrame,
  parseInstanceShellServerControlFrame,
} from "../src/instance-shell.ts";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  controlledInstanceShellCapabilities,
  normalizeControlledInstanceCapabilities,
  supportsControlledInstanceShell,
} from "../src/control-plane.ts";
import {
  directoryInstanceShellCapabilities,
  supportsDirectoryAiSessionQueuePause,
  supportsDirectoryInstanceShell,
} from "../src/control-plane-directory.ts";

test("instance-shell identity is versioned at the websocket boundary", () => {
  assert.equal(INSTANCE_SHELL_PROTOCOL_VERSION, "2026-10-31");
  assert.equal(INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL, "task-handoff.instance-shell.2026-10-31");
});

test("client control frames preserve argv boundaries and validate mode-specific fields", () => {
  assert.deepEqual(parseInstanceShellClientControlFrame(JSON.stringify({
    type: "start",
    mode: "exec",
    command: ["printf", "%s", "", "a b", "--json", "你好"],
    tty: false,
  })), {
    type: "start",
    mode: "exec",
    command: ["printf", "%s", "", "a b", "--json", "你好"],
    tty: false,
  });
  assert.deepEqual(parseInstanceShellClientControlFrame(JSON.stringify({
    type: "start",
    mode: "interactive",
    tty: true,
    cols: 120,
    rows: 40,
  })), {
    type: "start",
    mode: "interactive",
    tty: true,
    cols: 120,
    rows: 40,
  });
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "start", mode: "interactive", tty: false })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "start", mode: "interactive", tty: true, command: ["sh"] })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "start", mode: "exec", tty: false, command: [] })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "start", mode: "exec", command: ["x"], tty: false, cols: 80 })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "start", mode: "exec", command: ["x"], tty: false, cols: 0, rows: 24 })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame(JSON.stringify({ type: "resize", cols: 80, rows: 24, extra: true })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame("not-json"), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellClientControlFrame("x".repeat(INSTANCE_SHELL_CONTROL_FRAME_MAX_BYTES + 1)), InstanceShellProtocolError);
});

test("control schemas cover half-close, resize, signals, startup, and exit", () => {
  assert.deepEqual(parseInstanceShellClientControlFrame(JSON.stringify({ type: "stdin-close" })), { type: "stdin-close" });
  assert.deepEqual(parseInstanceShellClientControlFrame(JSON.stringify({ type: "resize", cols: 80, rows: 24 })), { type: "resize", cols: 80, rows: 24 });
  assert.deepEqual(parseInstanceShellClientControlFrame(JSON.stringify({ type: "signal", signal: "SIGINT" })), { type: "signal", signal: "SIGINT" });
  assert.deepEqual(parseInstanceShellServerControlFrame(JSON.stringify({
    type: "started", protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, mode: "exec", tty: false,
  })), {
    type: "started", protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, mode: "exec", tty: false,
  });
  assert.deepEqual(parseInstanceShellServerControlFrame(JSON.stringify({ type: "exit", code: 7 })), { type: "exit", code: 7 });
  assert.deepEqual(parseInstanceShellServerControlFrame(JSON.stringify({ type: "exit", signal: "SIGTERM" })), { type: "exit", signal: "SIGTERM" });
  assert.throws(() => parseInstanceShellServerControlFrame(JSON.stringify({ type: "exit" })), InstanceShellProtocolError);
  assert.throws(() => parseInstanceShellServerControlFrame(JSON.stringify({ type: "exit", code: 0, signal: "SIGTERM" })), InstanceShellProtocolError);
});

test("binary channel codec is byte exact, including invalid UTF-8, NUL, and CRLF", () => {
  const payload = Uint8Array.from([0xff, 0x00, 0x0d, 0x0a, 0x80]);
  const decoded = decodeInstanceShellBinaryFrame(encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Output, payload), "instance-to-client");
  assert.equal(decoded.channel, InstanceShellDataChannel.Output);
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));

  for (const channel of [InstanceShellDataChannel.Input, InstanceShellDataChannel.Output, InstanceShellDataChannel.Stderr]) {
    const encoded = encodeInstanceShellBinaryFrame(channel, payload);
    assert.equal(encoded.byteLength, payload.byteLength + 1);
  }
});

test("binary channel codec rejects empty payloads, unknown channels, and the wrong direction", () => {
  assert.throws(() => encodeInstanceShellBinaryFrame(InstanceShellDataChannel.Input, new Uint8Array()), InstanceShellProtocolError);
  assert.throws(() => decodeInstanceShellBinaryFrame(Uint8Array.of(InstanceShellDataChannel.Input), "client-to-instance"), InstanceShellProtocolError);
  assert.throws(() => decodeInstanceShellBinaryFrame(Uint8Array.of(0x04, 1), "client-to-instance"), InstanceShellProtocolError);
  assert.throws(() => decodeInstanceShellBinaryFrame(Uint8Array.of(InstanceShellDataChannel.Output, 1), "client-to-instance"), InstanceShellProtocolError);
  assert.throws(() => decodeInstanceShellBinaryFrame(Uint8Array.of(InstanceShellDataChannel.Input, 1), "instance-to-client"), InstanceShellProtocolError);
});

test("controlled-instance and directory capability queries disable only instance-shell for old or malformed values", () => {
  const old = normalizeControlledInstanceCapabilities({ features: { tty: true } });
  assert.equal(old.features.tty, true);
  assert.equal(supportsControlledInstanceShell({ features: { tty: true } }), false);
  assert.deepEqual(controlledInstanceShellCapabilities({ features: { tty: true } }), {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: false,
    exec: false,
    execTty: false,
  });

  const current = {
    features: {
      tty: true,
      instanceShell: { protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, interactive: true, exec: true, execTty: true, future: "ignored" },
    },
  };
  assert.equal(supportsControlledInstanceShell(current), true);
  assert.deepEqual(controlledInstanceShellCapabilities(current), {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: true,
    exec: true,
    execTty: true,
  });
  assert.equal(supportsControlledInstanceShell({
    features: { instanceShell: { protocolVersion: "2026-10-30", interactive: true, exec: true, execTty: true } },
  }), false);

  const directory = {
    aiSessionQueuePause: true,
    browserTunnel: true,
    instanceShell: { protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION, interactive: true, exec: true, execTty: false, future: true },
  };
  assert.equal(supportsDirectoryAiSessionQueuePause(directory), true);
  assert.equal(supportsDirectoryInstanceShell(directory), true);
  assert.deepEqual(directoryInstanceShellCapabilities(directory), {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: true,
    exec: true,
    execTty: false,
  });
  assert.equal(supportsDirectoryInstanceShell({ aiSessionQueuePause: true, instanceShell: { protocolVersion: "2026-10-31" } }), false);
  assert.equal(supportsDirectoryAiSessionQueuePause({ aiSessionQueuePause: true, instanceShell: "invalid" }), true);
  assert.equal(supportsDirectoryInstanceShell({ instanceShell: { protocolVersion: "2026-10-30", interactive: true, exec: true, execTty: true } }), false);
});

test("instance-shell capability survives register and heartbeat wire parsing without changing other feature domains", () => {
  const capability = {
    protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
    interactive: true,
    exec: true,
    execTty: false,
  };
  const appInventory = { observedAt: "2026-10-31T00:00:00.000Z", items: [], issues: [] };
  const register = ControlledInstanceRegisterSchema.parse({
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    capabilities: { features: { tty: true, instanceShell: { ...capability, future: "ignored" } } },
    appInventory,
  });
  const heartbeat = ControlledInstanceHeartbeatSchema.parse({
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    status: "running",
    capabilities: { features: { tty: true, instanceShell: capability } },
    appInventory,
  });

  assert.equal(register.capabilities.features.tty, true);
  assert.deepEqual(register.capabilities.features.instanceShell, capability);
  assert.equal(heartbeat.capabilities?.features.tty, true);
  assert.deepEqual(heartbeat.capabilities?.features.instanceShell, capability);
});
