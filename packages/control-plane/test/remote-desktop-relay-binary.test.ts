import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserChannelMessage } from "@task-handoff/protocol/relay-browser-channel";

import { createRemoteDesktopChannel } from "../src/control-plane/remote-desktop/relay-channel.ts";

test("remote desktop Relay preserves text frames carried as Buffers", async () => {
  const received: BrowserChannelMessage[] = [];
  const bridge = createRemoteDesktopChannel({
    async onMessage(message) { received.push(message); },
    onClose() {},
  });

  bridge.socket.send(Buffer.from('{"type":"fallback.configure"}'), { binary: false });
  bridge.socket.send(Buffer.from([0x52, 0x44]), { binary: true });
  const deadline = Date.now() + 1_000;
  while (received.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.deepEqual(received.map((message) => message.binary), [false, true]);
  assert.equal(new TextDecoder().decode(received[0].bytes), '{"type":"fallback.configure"}');
  assert.deepEqual([...received[1].bytes], [0x52, 0x44]);
});
