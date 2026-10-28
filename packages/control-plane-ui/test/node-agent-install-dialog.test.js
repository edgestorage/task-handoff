import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the quick installer dialog switches script source next to the copy action", () => {
  const dialog = read("src/apps/control-plane/settings/NodeAgentInstallDialog.vue");
  assert.match(dialog, /<NodeAgentInstallerSourceToggle v-model="installerSource" \/>/);
  assert.match(dialog, /installerSource = ref<NodeAgentInstallerSource>\(DEFAULT_NODE_AGENT_INSTALLER_SOURCE\)/);
  assert.match(dialog, /installerSource: installerSource\.value/);
  assert.match(dialog, /installerSource\.value = DEFAULT_NODE_AGENT_INSTALLER_SOURCE/);
  assert.match(dialog, /watch\(\[controlPlaneUrl, installerSource\], \(\) => \{\n  copied\.value = false;/);
});

test("the installer source switch names the repository source GitHub", () => {
  const toggle = read("src/apps/control-plane/settings/NodeAgentInstallerSourceToggle.vue");
  assert.match(toggle, /value="github"/);
  assert.match(toggle, /settings\.nodeDialogs\.installerSourceGitHub/);
  assert.doesNotMatch(toggle, /installerSourceCloud|value="cloud"/);
});
