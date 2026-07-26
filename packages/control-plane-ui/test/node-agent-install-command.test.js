import assert from "node:assert/strict";
import test from "node:test";
import { nodeAgentInstallCommand, normalizeControlPlaneBaseUrl } from "../src/apps/control-plane/settings/nodeAgentInstallCommand.ts";

test("node-agent install command uses one control-plane URL and the one-time token", () => {
  const command = nodeAgentInstallCommand({
    controlPlaneUrl: " https://control.example.com/ ",
    joinToken: "join_secret",
    version: "1.2.3",
  });

  assert.match(command, /https:\/\/control\.example\.com\/install-node-agent\.sh/);
  assert.match(command, /--control-plane 'https:\/\/control\.example\.com'/);
  assert.match(command, /--join-token 'join_secret'/);
  assert.match(command, /--npm-package @task-handoff\/node-agent/);
  assert.match(command, /--controlled-instance-package @task-handoff\/controlled-instance/);
  assert.match(command, /--version '1\.2\.3'/);
});

test("node-agent install command safely quotes shell values and allows an unpinned package", () => {
  const command = nodeAgentInstallCommand({ controlPlaneUrl: "https://host.example/a'b", joinToken: "token'value" });

  assert.match(command, /'"'"'/);
  assert.doesNotMatch(command, /--version/);
  assert.equal(normalizeControlPlaneBaseUrl(" https://host.example/// "), "https://host.example");
  assert.equal(nodeAgentInstallCommand({ controlPlaneUrl: "", joinToken: "token" }), "");
  assert.equal(nodeAgentInstallCommand({ controlPlaneUrl: "control-plane.local", joinToken: "token" }), "");
});

test("node-agent install command removes browser query and fragment state before appending the installer path", () => {
  const command = nodeAgentInstallCommand({
    controlPlaneUrl: "https://CONTROL.example.com/base/?source=settings#nodes",
    joinToken: "token",
  });

  assert.match(command, /curl -fsSL 'https:\/\/control\.example\.com\/base\/install-node-agent\.sh'/);
  assert.match(command, /--control-plane 'https:\/\/control\.example\.com\/base'/);
  assert.doesNotMatch(command, /source=settings|#nodes/);
});
