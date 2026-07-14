import assert from "node:assert/strict";
import test from "node:test";

import { nodeEndpointDisplay } from "../src/apps/control-plane/settings/nodeEndpointDisplay.ts";

test("node endpoint display decodes local IPC socket paths", () => {
  assert.equal(
    nodeEndpointDisplay("ipc://%2Ftmp%2Ftask-handoff-node-agent-501%2Fcontrol.sock"),
    "ipc:///tmp/task-handoff-node-agent-501/control.sock",
  );
});

test("node endpoint display preserves non-IPC and malformed endpoints", () => {
  assert.equal(nodeEndpointDisplay("https://node.example.test"), "https://node.example.test");
  assert.equal(nodeEndpointDisplay("ipc://%invalid"), "ipc://%invalid");
  assert.equal(nodeEndpointDisplay(undefined), "");
});
