import assert from "node:assert/strict";
import test from "node:test";

import { nodeRelayInstallCommand } from "../src/control-plane/cloud-connectivity/node-install-command.ts";

test("cloud-relay install command defaults to discovery and the GitHub-hosted installer", () => {
  const command = nodeRelayInstallCommand({
    controlPlaneUrl: "https://control.example.com",
    bindingToken: "binding'secret",
  });

  assert.match(command, /https:\/\/raw\.githubusercontent\.com\/edgestorage\/task-handoff\/main\/scripts\/install-node-agent\.sh/);
  assert.doesNotMatch(command, /--cloud-relay-origin/);
  assert.match(command, /--cloud-relay-bind-token 'binding'"'"'secret'/);
  assert.doesNotMatch(command, /control\.example\.com\/install-node-agent/);
});

test("cloud-relay install command keeps an explicit origin override for ad-hoc clouds", () => {
  const command = nodeRelayInstallCommand({
    controlPlaneUrl: "https://control.example.com",
    cloudOrigin: "https://cloud.example.com",
    bindingToken: "binding_secret",
  });

  assert.match(command, /--cloud-relay-origin 'https:\/\/cloud\.example\.com'/);
});

test("cloud-relay install command can use the Control Plane-hosted installer", () => {
  const command = nodeRelayInstallCommand({
    controlPlaneUrl: "https://control.example.com/base/?source=dialog#install",
    cloudOrigin: "https://cloud.example.com",
    bindingToken: "binding_secret",
    installerSource: "control-plane",
  });

  assert.match(command, /^curl -fsSL 'https:\/\/control\.example\.com\/base\/install-node-agent\.sh' \| sudo sh -s --/);
  assert.doesNotMatch(command, /github\.com|source=dialog|#install/);
});
