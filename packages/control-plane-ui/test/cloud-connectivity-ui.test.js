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
  assert.match(component, /const signedIn = computed/);
  assert.match(component, /v-if="!signedIn && !waitingForSignIn"/);
  assert.match(component, /v-if="!signedIn && \(state\.status === 'unbound' \|\| state\.status === 'pending-claim'\)" class="cloud-warning"/);
  assert.match(component, /settings\.cloud\.boundAccount/);
  assert.match(component, /settings\.cloud\.relayTitle/);
  assert.match(component, /v-if="signedIn && \(state\.status === 'unbound' \|\| state\.status === 'pending-claim'\)"/);
  assert.match(component, /waitingForBinding/);
  assert.match(component, /settings\.cloud\.signInFirst/);
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
