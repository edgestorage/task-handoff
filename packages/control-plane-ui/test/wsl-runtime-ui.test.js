import assert from "node:assert/strict";
import test from "node:test";
import {
  instanceRuntimeNameLabel,
  instanceRuntimeUnavailableLabel,
  instanceRuntimeUnavailableReason,
} from "../src/apps/control-plane/useInstanceStatus.ts";
import { runtimeTypeKeys } from "../src/i18n/status.ts";

const t = (key) => key;

function wslInstance(capabilities) {
  return { runtime: { type: "wsl", name: "WSL", capabilities: capabilities ?? {} } };
}

test("WSL runtimes resolve to a dedicated localized name and availability label", () => {
  assert.equal(instanceRuntimeNameLabel(wslInstance(), t), "instances.lifecycle.runtimeNameWsl");
  assert.equal(instanceRuntimeUnavailableLabel(wslInstance(), t), "instances.lifecycle.runtimeUnavailableWsl");
  assert.equal(runtimeTypeKeys.wsl, "settings.nodeDetail.runtimeWsl");
});

test("WSL availability diagnostics are read from the runtime-named capability subdomain", () => {
  assert.equal(instanceRuntimeUnavailableReason(wslInstance({ wsl: { status: "offline", error: "WSL 3.0 is not installed" } })), "WSL 3.0 is not installed");
  assert.equal(instanceRuntimeUnavailableReason(wslInstance({ wsl: { status: "online" } })), undefined);
  // Docker continues to read its own subdomain; unknown runtimes degrade to no reason.
  assert.equal(instanceRuntimeUnavailableReason({ runtime: { type: "docker", capabilities: { daemon: { error: "not running" } } } }), "not running");
  assert.equal(instanceRuntimeUnavailableReason({ runtime: { type: "wsl", capabilities: {} } }), undefined);
});
