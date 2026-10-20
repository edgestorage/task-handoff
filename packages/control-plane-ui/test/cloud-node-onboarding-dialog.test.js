import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("cloud node onboarding is a standalone source and connection flow", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /"source" \| "connect" \| "complete"/);
  assert.match(dialog, /settings\.nodeRelay\.sourceExisting/);
  assert.match(dialog, /settings\.nodeRelay\.sourceNew/);
  assert.match(dialog, /cloudRelayUsable/);
  assert.match(dialog, /settings\.nodeRelay\.unavailableSignedIn/);
  assert.match(dialog, /emit\('open-cloud-settings'\)/);
  assert.match(dialog, /claimCloudAccountNode/);
  assert.match(dialog, /createCloudNodeBindingToken/);
  assert.match(dialog, /cancelCloudNodeBindingToken/);
  assert.match(dialog, /accountNodeAccess/);
  assert.match(dialog, /item\.access\?\.kind === 'shared'/);
  assert.match(dialog, /connectAccountNode\(item\.nodeHandle\)/);
});

test("cloud node onboarding shows one generated command for the selected node state", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /commandMode = ref<CommandMode>\("install"\)/);
  assert.match(dialog, /commandMode\.value === "install" \? bindingToken\.value\?\.installCommand/);
  assert.match(dialog, /bindingToken\.value\?\.command/);
  assert.match(dialog, /<Tabs v-model="commandMode">/);
  assert.match(dialog, /<TabsTrigger value="install">/);
  assert.match(dialog, /<TabsTrigger value="bind">/);
  assert.doesNotMatch(dialog, /cloud-node-onboarding-source-switch/);
  assert.equal((dialog.match(/<pre><code>\{\{ generatedCommand \}\}<\/code><\/pre>/g) || []).length, 1);

  const tokenStart = dialog.indexOf('<template v-else>\n              <p class="cloud-node-onboarding-instruction">{{ t("settings.nodeRelay.commandOnce") }}</p>');
  const tokenEnd = dialog.indexOf('</template>', tokenStart);
  const tokenSection = dialog.slice(tokenStart, tokenEnd);
  assert.match(tokenSection, /settings\.nodeRelay\.installCommand/);
  assert.match(tokenSection, /settings\.nodeRelay\.bindCommand/);
});

test("cloud account nodes use the compact settings-style separated list", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /<ul v-else-if="accountNodeItems\.length" class="cloud-node-onboarding-account-list">/);
  assert.match(dialog, /class="cloud-node-onboarding-account-item"/);
  assert.match(dialog, /\.cloud-node-onboarding-account-list \{[\s\S]*?overflow: hidden;[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?border-radius: 8px;/);
  assert.match(dialog, /\.cloud-node-onboarding-account-item \+ \.cloud-node-onboarding-account-item \{\s*border-top: 1px solid var\(--line\);/);
});
