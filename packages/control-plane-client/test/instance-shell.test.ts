import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLED_INSTANCE_SHELL_PROTOCOL,
  controlledInstanceShellRoute,
} from "../src/instance-shell.ts";

test("instance shell has one shared encoded route and versioned subprotocol", () => {
  assert.equal(controlledInstanceShellRoute("inst a/b"), "/api/controlled-instances/inst%20a%2Fb/shell");
  assert.equal(CONTROLLED_INSTANCE_SHELL_PROTOCOL, "task-handoff.instance-shell.2026-10-31");
  assert.throws(() => controlledInstanceShellRoute("  "));
});
