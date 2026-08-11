import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("account security tab is available only when account sign-in is enabled", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");

  assert.match(settings, /authSession\.data\.value\?\.enabled \? \[\{ id: "account" as const/);
  assert.match(settings, /!enabled && settingsSection\.value === "account"/);
  assert.match(settings, /setSettingsSection\("nodes"\)/);
});
