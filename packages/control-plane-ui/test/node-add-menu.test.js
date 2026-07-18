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

  assert.match(addMenu, /Add local node/);
  assert.match(addMenu, /Use this control plane as a node/);
  assert.match(addMenu, /Add remote node/);
  assert.match(addMenu, /Connect an existing node by endpoint/);
  assert.match(addMenu, /Generate join token/);
  assert.match(addMenu, /Allow a node to connect securely/);
  assert.equal((addMenu.match(/class="node-add-menu-item"/g) || []).length, 3);
  assert.match(addMenu, /@select="createJoinInvite"/);
  assert.doesNotMatch(remoteDialog, /createJoinInvite|Generate join token|Allow a node to join/);
});
