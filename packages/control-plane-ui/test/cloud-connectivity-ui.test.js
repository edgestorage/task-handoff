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
  assert.match(component, /const connectionStage = computed/);
  assert.match(component, /settings\.cloud\.boundAccount/);
  assert.match(component, /settings\.cloud\.relayTitle/);
  assert.match(component, /settings\.cloud\.loginAndBind/);
  assert.match(component, /settings\.cloud\.signInOnly/);
  assert.match(component, /settings\.cloud\.bindToAccount/);
  assert.doesNotMatch(component, /settings\.cloud\.manageNodes|@click="tab = 'node-management'"/);
  assert.match(component, /waitingForBinding/);
  assert.match(component, /requestFailure/);
  assert.match(component, /signInDeliveryFailed/);
  assert.match(component, /reauthRequired/);
  assert.match(component, /settings\.cloud\.sessionExpired/);
  assert.match(queries, /query\.state\.data\?\.signedIn \? 15_000/);
});

test("an active binding can sign back in after the account session is signed out", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const accountRow = component.match(/<section v-if="signedIn \|\| connectionStage === 'active'"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(accountRow, /v-if="signedIn"[\s\S]*@click="signOutOpen = true"/);
  assert.match(accountRow, /<Button v-else[^>]*:disabled="busy \|\| waitingForSignIn \|\| Boolean\(originConflict\)"[^>]*@click="signIn\('sign-in'\)"/);
  assert.match(accountRow, /settings\.cloud\.accountSessionNote/);
  assert.match(accountRow, /settings\.cloud\.accountSignedOutNote/);
  assert.match(component, /<p v-if="!signedIn" class="cloud-node-picker-warning"[\s\S]{0,400}signIn\('sign-in'\)/);
});

test("signing in only and signing in to bind keep separate intents", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const stateMachine = read("src/apps/control-plane/settings/cloudConnectionState.ts");

  assert.match(stateMachine, /export type CloudLoginIntent = "sign-in" \| "bind"/);
  assert.match(component, /type LoginIntent = CloudLoginIntent/);
  assert.match(component, /const loginIntent = ref<LoginIntent \| null>\(null\)/);
  assert.match(component, /signIn\('bind'\)/);
  assert.match(component, /signIn\('sign-in'\)/);
  assert.match(component, /watch\(\[signedIn, busy\], async \(\[value, isBusy\]\) => \{[\s\S]*if \(intent !== "bind"\) return;/);
  assert.match(component, /if \(status !== "unbound" && status !== "pending-claim"\) return;/);
});

test("cloud settings explain background ownership and expose structured non-color states", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const stateMachine = read("src/apps/control-plane/settings/cloudConnectionState.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  assert.match(component, /settings\.cloud\.backgroundNote/);
  assert.match(component, /connectionStage/);
  assert.match(component, /resolveCloudConnectionStage/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.match(stateMachine, /status === "clone-conflict"\) return "conflict"/);
  assert.match(english, /Runs in the background; closing this page or signing out of the local UI/);
  assert.match(chinese, /后台独立运行；关闭页面或退出本地 UI/);
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

test("cloud nodes are published from an independent tab without a global relay switch", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");
  const tabs = component.match(/<TabsList[\s\S]*?<\/TabsList>/)?.[0] || "";

  assert.match(tabs, /value="connection"[\s\S]*value="node-management"[\s\S]*value="roles"[\s\S]*value="trusted-devices"/);
  assert.match(component, /v-if="tab === 'node-management' && state\?\.status === 'active' && !originConflict"/);
  assert.match(component, /tab === 'node-management'[\s\S]*settings\.cloud\.nodeManagementNote[\s\S]*v-for="node in cloudNodes"/);
  assert.doesNotMatch(component, /settings\.cloud\.nodeRelay|setScope\('nodeRelay'/);
  assert.match(component, /nodeManagementRequiresConnection/);
  assert.match(component, /nodeManagementUnbindNote/);
  assert.match(chinese, /nodeManagement: "云平台节点"/);
  assert.match(chinese, /节点与本控制面的原有连接不受影响/);
  assert.match(english, /nodeManagement: "Cloud nodes"/);
  assert.match(english, /existing node connections to this Control Plane are unchanged/);
});

test("adding a cloud node never mutates a relay authorization switch", () => {
  const bind = read("src/apps/control-plane/settings/CloudRelayBindPanel.vue");
  const detail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");

  assert.match(bind, /@click="primaryAction"/);
  assert.match(bind, /async function bind\(\)[\s\S]*bindCloudRelayNode/);
  assert.doesNotMatch(bind, /updateCloudScopes|nodeRelay/);
  assert.match(bind, /emit\("open-cloud-settings"\)/);
  assert.match(bind, /cloudRelayBindSignInAction/);
  assert.match(bind, /cloudRelayBindSetupAction/);
  assert.doesNotMatch(bind, /cloudRelayBindEnableScope|cloudRelayBindRequiresScope/);
  assert.match(bind, /CLOUD_ACCOUNT_NODE_HANDLE_LABEL/);
  assert.match(bind, /<Badge v-if="linkedHandle"/);
  assert.match(detail, /@open-cloud-settings="emit\('open-cloud-settings'\)"/);
  assert.match(settings, /<NodeDetailPanel[\s\S]*@open-cloud-settings="setSettingsSection\('cloud-connectivity'\)"/);
  assert.doesNotMatch(chinese, /cloudRelayBindEnableScopeAction|cloudRelayBindRequiresScope/);
  assert.doesNotMatch(english, /cloudRelayBindEnableScopeAction|cloudRelayBindRequiresScope/);
  assert.doesNotMatch(chinese, /bothScopesOffNote|unavailableScope/);
  assert.doesNotMatch(english, /bothScopesOffNote|unavailableScope/);
});

test("cloud nodes expose a clickable list of local nodes to publish", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");

  assert.match(component, /useNodesQuery\(\)/);
  assert.match(component, /v-for="node in cloudNodes"/);
  assert.match(component, /class="cloud-node-row"/);
  assert.match(component, /@click="addNode\(node\)"/);
  assert.match(component, /bindCloudRelayNode\(node\.id\)/);
  assert.doesNotMatch(component, /updateCloudScopes|setCloudScopes|nodeRelay\s*:/);
  assert.match(component, /nodeCloudHandle\(node\)/);
  assert.match(component, /CLOUD_ACCOUNT_NODE_HANDLE_LABEL/);
  assert.match(component, /node\.labels\[CLOUD_ACCOUNT_NODE_HANDLE_LABEL\]/);
  assert.match(component, /settings\.cloud\.nodeAdded/);
  assert.match(component, /class="cloud-directory cloud-node-picker"/);
});

test("archived Cloud roles can be removed but cannot be made available again", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");

  assert.match(component, /role\.roleId === accessSettings\.data\.value\.ownerRoleId \|\| \(role\.status === 'archived' && !roleDraft\.includes\(role\.roleId\)\)/);
  assert.match(component, /roleId === settings\.ownerRoleId \|\| \(available && role\.status === "archived"\)/);
  assert.match(component, /archivedDraftRoles\.value\.length === 0/);
  assert.match(component, /settings\.cloud\.rolesArchivedSelected/);
});

test("Cloud roles use the published catalog and preserve conflict context", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const queries = read("src/api/queries.ts");
  const client = read("../control-plane-client/src/control-plane-admin.ts");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");

  assert.match(component, /accessSettings\.data\.value\?\.roles/);
  assert.match(component, /role\.status === "archived"/);
  assert.match(component, /role\.roleId === accessSettings\.data\.value\.ownerRoleId/);
  assert.match(component, /expectedSettingsRevision: settings\.settingsRevision/);
  assert.match(component, /code === "REVISION_CONFLICT"/);
  assert.match(component, /code === "CONTROL_PLANE_ACCESS_ROLE_IN_USE"/);
  assert.match(component, /entry\.owner === true/);
  assert.match(component, /entry\.grantees/);
  assert.match(component, /function roleName\(roleId: string\)[\s\S]*\?\.name \|\| roleId/);
  assert.match(queries, /useCloudAccessSettingsQuery[\s\S]*admin\.cloudAccessSettings\(\)/);
  assert.match(queries, /updateCloudAvailableRoles[\s\S]*admin\.updateCloudAccessSettings/);
  assert.match(queries, /useCloudConnectivityQuery[\s\S]*status === "active"\) return 10_000;[\s\S]*status === "pending-claim" \|\| status === "pending-revocation"\) return 3_000/);
  assert.match(component, /watch\(\(\) => state\.value\?\.catalogPublication\?\.revision[\s\S]*status !== "published"[\s\S]*accessSettings\.refetch\(\)/);
  assert.match(client, /cloudAccessSettings\(signal\?: AbortSignal\)/);
  assert.match(client, /updateCloudAccessSettings\(input: \{ expectedSettingsRevision: number; availableRoleIds: string\[\] \}\)/);
  assert.match(english, /Cloud roles/);
  assert.match(chinese, /云平台角色/);
});
