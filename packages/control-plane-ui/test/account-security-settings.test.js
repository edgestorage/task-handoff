import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("account security opens as a user-menu dialog outside settings navigation", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const account = read("src/apps/control-plane/settings/AccountSecurityDialog.vue");

  assert.doesNotMatch(settings, /AccountSecurity|id: "account"|settingsSection === ['"]account['"]/);
  assert.match(workbench, /@select="openAccountSecurity"/);
  assert.match(workbench, /<AccountSecurityDialog v-model:open="accountSecurityOpen"/);
  assert.match(account, /<Dialog :open="open"/);
  assert.match(account, /changeControlPlanePassword/);
});
