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

test("cloud node onboarding derives query readiness before creating the query", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  const readiness = dialog.indexOf("const cloudRelayUsable = computed");
  const query = dialog.indexOf("const accountNodes = useCloudAccountNodesQuery");
  assert.ok(readiness >= 0, "cloudRelayUsable is declared");
  assert.ok(query >= 0, "accountNodes query is declared");
  assert.ok(readiness < query, "cloudRelayUsable must be initialized before the query reads it");
});

test("cloud node onboarding shows one generated command for the selected node state", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /commandMode = ref<CommandMode>\("install"\)/);
  assert.match(dialog, /const command = bindingToken\.value\?\.installCommand \?\? ""/);
  assert.match(dialog, /withNodeAgentInstallerSource\(command, \{ controlPlaneUrl: props\.controlPlaneUrl, installerSource: installerSource\.value \}\)/);
  assert.match(dialog, /bindingToken\.value\?\.command/);
  assert.match(dialog, /installerSource = ref<NodeAgentInstallerSource>\(DEFAULT_NODE_AGENT_INSTALLER_SOURCE\)/);
  assert.match(dialog, /watch\(installerSource, \(\) => \{\n  copied\.value = false;/);
  assert.match(dialog, /<NodeAgentInstallerSourceToggle v-if="commandMode === 'install'" v-model="installerSource" \/>/);
  assert.match(dialog, /<Tabs v-model="commandMode">/);
  assert.match(dialog, /<TabsTrigger value="install">/);
  assert.match(dialog, /<TabsTrigger value="bind">/);
  assert.doesNotMatch(dialog, /cloud-node-onboarding-source-switch/);
  assert.equal((dialog.match(/<ScrollArea class="cloud-node-onboarding-command-code">\n\s*<pre tabindex="0"><code>\{\{ generatedCommand \}\}<\/code><\/pre>/g) || []).length, 1);

  const tokenStart = dialog.indexOf('<div class="cloud-node-onboarding-command-card">');
  const tokenEnd = dialog.indexOf('</template>', tokenStart);
  const tokenSection = dialog.slice(tokenStart, tokenEnd);
  assert.match(tokenSection, /settings\.nodeRelay\.commandOnce/);
  assert.match(tokenSection, /settings\.nodeRelay\.installCommand/);
  assert.match(tokenSection, /settings\.nodeRelay\.bindCommand/);
});

test("the generated command groups its actions into one compact card", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /class="cloud-node-onboarding-command-footer"/);
  assert.match(dialog, /class="cloud-node-onboarding-command-cancel"/);
  assert.match(dialog, /<ScrollArea class="cloud-node-onboarding-command-code">/);
  assert.match(dialog, /\.cloud-node-onboarding-command-code :deep\(pre\) \{[\s\S]*?white-space: pre;/);
  assert.doesNotMatch(dialog, /variant="destructive"[^>]*cancelBindingToken/);
});

test("cloud account nodes use the compact settings-style separated list", () => {
  const dialog = read("src/apps/control-plane/settings/CloudNodeOnboardingDialog.vue");
  assert.match(dialog, /<ul v-else-if="accountNodeItems\.length" class="cloud-node-onboarding-account-list">/);
  assert.match(dialog, /class="cloud-node-onboarding-account-item"/);
  assert.match(dialog, /\.cloud-node-onboarding-account-list \{[\s\S]*?overflow: hidden;[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?border-radius: 8px;/);
  assert.match(dialog, /\.cloud-node-onboarding-account-item \+ \.cloud-node-onboarding-account-item \{\s*border-top: 1px solid var\(--line\);/);
});
