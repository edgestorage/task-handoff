import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("cloud connectivity settings are visible only with settings management permission", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const sections = read("src/apps/control-plane/settings/settingsSections.ts");
  assert.match(settings, /permissionIds\.includes\("settings:manage"\)/);
  assert.match(settings, /!manageSettings.*settingsSection\.value === "cloud-connectivity"/);
  assert.match(settings, /setSettingsSection\("nodes"\)/);
  assert.match(sections, /access\.manageSettings && isFeatureEnabled\("officialAccount"\)/);
});

test("sign-in and binding both open the official approval page without a copied code", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const queries = read("src/api/queries.ts");
  assert.doesNotMatch(component, /challengeCode/);
  assert.doesNotMatch(component, /clipboard/);
  assert.doesNotMatch(component, /CloudBindingChallenge/);
  assert.match(component, /createCloudSignInRequest\(\)/);
  assert.match(component, /createCloudBindingRequest\(\)/);
  assert.match(component, /reopen\(request\.authorizationUrl\)/);
  assert.match(component, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|setQueryData/);
  assert.match(queries, /useCloudConnectivityQuery[\s\S]*sharedControlPlaneClient\.admin\.cloudConnectivity\(\)/);
  assert.match(queries, /useCloudAccountQuery[\s\S]*sharedControlPlaneClient\.admin\.cloudAccount\(\)/);
  assert.match(queries, /updateCloudRemoteAccess\(enabled: boolean\)[\s\S]*sharedControlPlaneClient\.admin\.setCloudRemoteAccess\(enabled\)/);
  assert.match(queries, /disconnectCloudAccount\(\)[\s\S]*sharedControlPlaneClient\.admin\.disconnectCloud\(\)/);
});

test("account state decides which relay action is offered", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const queries = read("src/api/queries.ts");
  assert.match(component, /const signedIn = computed/);
  assert.match(component, /v-if="!signedIn && !waitingForSignIn"/);
  assert.match(component, /v-if="!signedIn && \(state\.status === 'unbound' \|\| state\.status === 'pending-claim'\)" class="cloud-warning"/);
  assert.match(component, /settings\.cloud\.boundAccount/);
  assert.match(component, /settings\.cloud\.relayTitle/);
  assert.match(component, /v-if="signedIn && \(state\.status === 'unbound' \|\| state\.status === 'pending-claim'\)"/);
  assert.match(component, /waitingForBinding/);
  assert.match(component, /settings\.cloud\.signInFirst/);
  assert.match(component, /requestFailure/);
  assert.match(component, /signInDeliveryFailed/);
  assert.match(component, /reauthRequired/);
  assert.match(component, /settings\.cloud\.sessionExpired/);
  assert.match(queries, /query\.state\.data\?\.signedIn \? 15_000/);
});

test("cloud settings explain background ownership and expose structured non-color states", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const english = read("src/i18n/locales/en-US/settings.ts");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  assert.match(component, /settings\.cloud\.backgroundNote/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /state\.status === 'clone-conflict'/);
  assert.match(english, /Closing this page, signing out of the local UI/);
  assert.match(chinese, /关闭此页面、退出本地 UI/);
  assert.doesNotMatch(component, /font-size:(?:[0-9]|1[01])px/);
});

test("Thandoff account follows the shared settings directory layout", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");

  assert.match(component, /class="cloud-connectivity-scroll settings-page-scroll"/);
  assert.match(component, /class="cloud-connectivity-page settings-content-page"/);
  assert.match(component, /class="cloud-page-head"/);
  assert.match(component, /class="cloud-directory"/);
  assert.match(component, /\.cloud-directory\{[^}]*background:var\(--surface-raised\)[^}]*border:1px solid var\(--line\)/);
  assert.doesNotMatch(component, /settings-panel-surface|modal-section/);
});

test("blocked cloud node actions can be resolved without following a text-only instruction", () => {
  const bind = read("src/apps/control-plane/settings/CloudRelayBindPanel.vue");
  const detail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");

  assert.match(bind, /@click="primaryAction"/);
  assert.match(bind, /updateCloudScopes\(\{ \.\.\.connectivity\.data\.value\.scopes, nodeRelay: true \}\)/);
  assert.match(bind, /emit\("open-cloud-settings"\)/);
  assert.match(bind, /cloudRelayBindSignInAction/);
  assert.match(bind, /cloudRelayBindSetupAction/);
  assert.match(bind, /cloudRelayBindEnableScopeAction/);
  assert.match(bind, /CLOUD_ACCOUNT_NODE_HANDLE_LABEL/);
  assert.match(bind, /Boolean\(linkedHandle\)/);
  assert.match(detail, /@open-cloud-settings="emit\('open-cloud-settings'\)"/);
  assert.match(settings, /<NodeDetailPanel[\s\S]*@open-cloud-settings="setSettingsSection\('cloud-connectivity'\)"/);
  assert.match(chinese, /cloudRelayBindEnableScopeAction: "开启节点管理"/);
  assert.match(english, /cloudRelayBindEnableScopeAction: "Enable node management"/);
});

test("cloud permissions expose a clickable list of managed nodes", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");

  assert.match(component, /useNodesQuery\(\)/);
  assert.match(component, /v-for="node in cloudNodes"/);
  assert.match(component, /class="cloud-node-row"/);
  assert.match(component, /@click="addNode\(node\)"/);
  assert.match(component, /bindCloudRelayNode\(node\.id\)/);
  assert.match(component, /updateCloudScopes\(\{ \.\.\.state\.value!\.scopes, nodeRelay: true \}\)/);
  assert.match(component, /nodeCloudHandle\(node\)/);
  assert.match(component, /CLOUD_ACCOUNT_NODE_HANDLE_LABEL/);
  assert.match(component, /node\.labels\[CLOUD_ACCOUNT_NODE_HANDLE_LABEL\]/);
  assert.match(component, /settings\.cloud\.nodeAdded/);
  assert.match(component, /\.cloud-node-picker\s*\{[^}]*border:1px solid var\(--line\)/s);
});
