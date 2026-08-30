import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const settings = read("src/apps/control-plane/settings/GitCredentialsSettingsSection.vue");
const newInstance = read("src/apps/control-plane/NewInstanceModal.vue");
const runtimeStep = read("src/apps/control-plane/new-instance/RuntimeStep.vue");
const sourceStep = read("src/apps/control-plane/new-instance/SourceStep.vue");
const projectSettings = read("src/apps/control-plane/settings/useProjectSettings.ts");
const instanceSettings = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const queries = read("src/api/queries.ts");
const client = read("src/api/client.ts");

test("credential secrets stay in ephemeral component state and bypass query caches", () => {
  assert.match(settings, /const emptyDraft = \(\) => \(\{[^}]*token: ""[^}]*privateKey: ""[^}]*passphrase: ""[^}]*knownHosts: ""/s);
  assert.match(settings, /function resetDraft\(\) \{ Object\.assign\(draft, emptyDraft\(\)\)/);
  assert.match(settings, /if \(!open\) \{ editing\.value = undefined; resetDraft\(\); \}/);
  assert.match(settings, /await createGitCredential\(/);
  assert.match(settings, /await updateGitCredential\(/);
  assert.doesNotMatch(settings, /useMutation|setQueryData|localStorage|sessionStorage|console\.|URLSearchParams/);
  assert.doesNotMatch(queries.slice(queries.indexOf("export function createGitCredential"), queries.indexOf("export function createNodeModel")), /useMutation|queryClient|localStorage|sessionStorage/);
  assert.doesNotMatch(client, /console\.|JSON\.stringify\([^)]*body/);
});

test("Repository owns the credential reference while instance creation owns only retention", () => {
  assert.match(workbench, /<NewInstanceModal v-if="!standaloneMode && newInstanceOpen"/);
  assert.match(projectSettings, /auth: credential \? \{ type: credential\.kind, secretId: credential\.id \} : \{ type: "none" \}/);
  assert.match(sourceStep, /newProject\.gitCredentialId/);
  assert.match(newInstance, /selectedProjectGitCredentialId\.value && instanceDraft\.retainGitCredential[\s\S]*gitCredentialRetention: "instance-retained"/);
  assert.doesNotMatch(newInstance, /gitCredentialRetention:[^\n]*operation-only/);
  assert.doesNotMatch(newInstance, /gitCredentialSelection|credentialId:\s*instanceDraft/);
  assert.match(newInstance, /instanceDraft\.retainGitCredential = false/);
  assert.doesNotMatch(newInstance, /setQueryData|localStorage|sessionStorage|URLSearchParams|showControlPlaneToast\([^)]*gitCredential/);
});

test("git credential controls follow canonical node and instance capabilities", () => {
  assert.match(newInstance, /supportsNodeGitWorkspaceProvisioning/);
  assert.match(newInstance, /supportsNodeManagedGitCredentialRegistry/);
  assert.match(newInstance, /:git-credential-provisioning-supported="gitCredentialProvisioningSupported"/);
  assert.match(runtimeStep, /v-if="gitSource && gitCredentialId && gitCredentialProvisioningSupported"/);
  assert.match(runtimeStep, /gitCredentialUnsupported/);
  assert.match(instanceSettings, /supportsGitCredentialProxy/);
});

test("instance settings derives credential match diagnostics from authoritative synced assignments", () => {
  assert.match(instanceSettings, /resolveGitCredential/);
  assert.match(instanceSettings, /assignment\.status === ["']synced["']/);
  assert.match(instanceSettings, /props\.instance\?\.source/);
  assert.match(instanceSettings, /instance-git-match-preview/);
  assert.doesNotMatch(instanceSettings, /(?:token|privateKey|passphrase|knownHosts)\s*:/);
});

test("credential form errors and success toasts never interpolate submitted secrets", () => {
  assert.match(settings, /formError\.value = errorText\(error, "saveFailed"\)/);
  assert.match(settings, /showControlPlaneToast\(t\("settings\.gitCredentials\.saved"\), "success"\)/);
  assert.doesNotMatch(settings, /showControlPlaneToast\([^)]*(?:draft|secret|token|privateKey|passphrase|knownHosts)/s);
  assert.doesNotMatch(settings, /formError\.value\s*=\s*(?:draft|secret|token|privateKey|passphrase|knownHosts)/);
});

test("Git credential settings follow the shared directory and editor patterns", () => {
  assert.match(settings, /class="git-credentials-toolbar"/);
  assert.match(settings, /class="git-credentials-directory"/);
  assert.match(settings, /v-for="credential in filteredCredentials"/);
  assert.match(settings, /<DropdownMenu>[\s\S]*<DropdownMenuContent align="end"/);
  assert.match(settings, /<ScrollArea class="git-credential-dialog-scroll"/);
  assert.match(settings, /class="git-credential-form-section"/);
  assert.match(settings, /<AlertDialog :open="Boolean\(pendingDelete\)"/);
  assert.match(settings, /<AlertDialog :open="closeConfirmationOpen"/);
});
