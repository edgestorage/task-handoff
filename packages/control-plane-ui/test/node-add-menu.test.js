import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("node creation actions live in the Add node menu", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const addMenu = settings.match(/<DropdownMenuContent class="node-add-menu"[\s\S]*?<\/DropdownMenuContent>/)?.[0] || "";
  const remoteDialog = settings.match(/<Dialog :open="remoteNodeDialogOpen"[\s\S]*?<\/Dialog>/)?.[0] || "";

  assert.match(addMenu, /@select="openNodeOnboarding"/);
  assert.match(addMenu, /settings\.nodeOnboarding\.title/);
  assert.match(addMenu, /settings\.nodeOnboarding\.recommended/);
  assert.match(addMenu, /class="node-onboarding-menu-badge"/);
  assert.match(addMenu, /<DropdownMenuSeparator\s*\/>/);
  assert.match(addMenu, /settings\.nodeRegistry\.addLocal/);
  assert.match(addMenu, /settings\.nodeRegistry\.localDescription/);
  assert.match(addMenu, /settings\.nodeRegistry\.addRemote/);
  assert.match(addMenu, /settings\.nodeRegistry\.remoteDescription/);
  assert.match(addMenu, /settings\.nodeRegistry\.installScript/);
  assert.match(addMenu, /settings\.nodeRegistry\.installDescription/);
  assert.match(addMenu, /settings\.nodeRegistry\.generateToken/);
  assert.match(addMenu, /settings\.nodeRegistry\.tokenDescription/);
  assert.equal((addMenu.match(/class="node-add-menu-item(?: [^"]*)?"/g) || []).length, 5);
  assert.match(addMenu, /@select="openNodeAgentInstallGuide"/);
  assert.match(addMenu, /@select="createJoinInvite"/);
  assert.ok(addMenu.indexOf("settings.nodeRegistry.generateToken") < addMenu.indexOf("settings.nodeRegistry.installScript"));
  assert.ok(addMenu.indexOf("settings.nodeOnboarding.title") < addMenu.indexOf("settings.nodeRegistry.addLocal"));
  assert.match(addMenu, /settings\.nodeRegistry\.installScript[\s\S]*<\/DropdownMenuItem>\s*<\/DropdownMenuContent>$/);
  assert.doesNotMatch(remoteDialog, /createJoinInvite|Generate join token|Allow a node to join/);
  assert.match(settings, /\.node-onboarding-menu-badge\)[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/);
});
