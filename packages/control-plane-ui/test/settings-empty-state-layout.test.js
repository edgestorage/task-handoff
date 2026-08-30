import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  ["src/apps/control-plane/settings/EnvironmentTemplatesSettings.vue", "environment-template-empty-state"],
  ["src/apps/control-plane/settings/ImageSettingsSection.vue", "image-empty-state"],
  ["src/apps/control-plane/settings/GitCredentialsSettingsSection.vue", "git-credentials-empty-state"],
  ["src/apps/control-plane/settings/ModelSettingsSection.vue", "model-empty-state"],
  ["src/apps/control-plane/settings/ProjectSettingsSection.vue", "project-empty-state"],
  ["src/apps/control-plane/settings/ChatBridgeSettingsSection.vue", "chat-empty-state"],
  ["src/apps/control-plane/triggers/ControlPlaneTriggersView.css", "trigger-empty-state"],
  ["src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue", "instance-settings-empty-state"],
];

test("grid empty states center their rows without stretching inter-item gaps", () => {
  for (const [relativePath, className] of cases) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const rule = source.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`))?.[1] || "";

    assert.match(rule, /display:\s*grid/, `${className} must use grid layout`);
    assert.match(rule, /align-content:\s*center/, `${className} must center its grid rows`);
  }
});
