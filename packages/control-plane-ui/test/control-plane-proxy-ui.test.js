import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeProxyOrigin, proxyClaimValidation, proxyForceDeleteAllowed, proxyPathState } from "../src/apps/control-plane/settings/controlPlaneProxyUi.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("proxy origins are canonical HTTPS origins", () => {
  assert.equal(normalizeProxyOrigin(" https://control-plane.example.com:8443 "), "https://control-plane.example.com:8443");
  for (const invalid of [
    "http://control-plane.example.com",
    "https://user@control-plane.example.com",
    "https://control-plane.example.com/api",
    "https://control-plane.example.com/?target=x",
    "https://control-plane.example.com/#claim",
  ]) {
    assert.throws(() => normalizeProxyOrigin(invalid), /INVALID_PROXY_ORIGIN/);
  }
});

test("claim submission requires an invite and explicit trusted control-plane confirmation", () => {
  const valid = { proxyOrigin: "https://control-plane.example.com", inviteToken: "x".repeat(24), trusted: true };
  assert.equal(proxyClaimValidation(valid), undefined);
  assert.equal(proxyClaimValidation({ ...valid, inviteToken: "short" }), "token");
  assert.equal(proxyClaimValidation({ ...valid, trusted: false }), "trust");
});

test("node UI keeps direct and proxy modes while separating proxy management and path status", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const detail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  assert.match(settings, /TabsTrigger value="direct"/);
  assert.match(settings, /TabsTrigger value="control-plane-proxy"/);
  assert.match(settings, /claimControlPlaneProxyNode/);
  assert.match(settings, /pendingProxyClaims/);
  assert.match(detail, /ControlPlaneProxyNodePanel/);
  assert.match(detail, /ControlPlaneProxyManagementPanel/);
});

test("proxy path status consumes the authoritative node proxyState only", () => {
  const panel = read("src/apps/control-plane/settings/ControlPlaneProxyNodePanel.vue");
  const projection = read("src/apps/control-plane/settings/controlPlaneProxyUi.ts");
  assert.match(projection, /const state = node\.proxyState/);
  assert.match(projection, /state\?\.reachability/);
  assert.match(projection, /state\?\.bindingStatus/);
  assert.match(projection, /state\?\.target/);
  assert.match(projection, /state\?\.lastError/);
  assert.doesNotMatch(panel, /diagnostics|selectedNode\.status/);
  assert.doesNotMatch(projection, /diagnostics|node\.status/);
});

test("one-time invite tokens stay in component-local state and never enter query cache", () => {
  const panel = read("src/apps/control-plane/settings/ControlPlaneProxyManagementPanel.vue");
  const queries = read("src/api/queries.ts");
  assert.match(panel, /generatedInvite\.value = await createControlPlaneProxyInvite/);
  assert.doesNotMatch(panel, /setQueryData/);
  assert.match(queries, /createControlPlaneProxyInvite[\s\S]*postApiData<CreateProxyInviteResult>/);
  assert.doesNotMatch(queries, /queryFn:[^\n]*createControlPlaneProxyInvite/);
});

test("proxy node deletion retries only after explicit orphan-risk confirmation", () => {
  const settings = read("src/apps/control-plane/settings/useNodeSettings.ts");
  const queries = read("src/api/queries.ts");
  assert.match(settings, /proxyForceDeleteAllowed\(target, error\)/);
  assert.doesNotMatch(settings, /startsWith\("CONTROL_PLANE_PROXY_"\)/);
  assert.match(settings, /forceDeleteConfirm/);
  assert.match(settings, /await deleteNode\(target\.id, true\)/);
  assert.match(queries, /force \? "\?force=true"/);
});

test("proxy force delete consumes explicit backend eligibility instead of an error-code prefix", () => {
  const proxyNode = { connectionMode: "control-plane-proxy" };
  assert.equal(proxyForceDeleteAllowed(proxyNode, { code: "ANY_CODE", details: { forceDeleteAllowed: true } }), true);
  assert.equal(proxyForceDeleteAllowed(proxyNode, { code: "CONTROL_PLANE_PROXY_REVOKE_FAILED", details: { forceDeleteAllowed: false } }), false);
  assert.equal(proxyForceDeleteAllowed(proxyNode, { code: "CONTROL_PLANE_PROXY_REVOKE_UNAVAILABLE" }), false);
  assert.equal(proxyForceDeleteAllowed({ connectionMode: "direct-http" }, { details: { forceDeleteAllowed: true } }), false);
});

test("pending claim resume uses only its persisted requested name", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const protocol = read("../protocol/src/control-plane-proxy.ts");
  assert.match(protocol, /PendingProxyClaimSchema[\s\S]*requestedName:/);
  assert.match(settings, /resumeControlPlaneProxyClaim\(id\)/);
  assert.doesNotMatch(settings, /resumeControlPlaneProxyClaim\(id,\s*\{\s*name:/);
});

test("public proxy projections do not expose stored credential material", () => {
  const types = read("src/api/types.ts");
  const publicTypes = types.slice(types.indexOf("export type PublicProxyInvite"), types.indexOf("export type ClaimProxyNodeResult"));
  assert.doesNotMatch(publicTypes, /tokenHash|credentialHash|credential:/);
});

test("proxy components distinguish loading, empty, success, and expired invite states", () => {
  const management = read("src/apps/control-plane/settings/ControlPlaneProxyManagementPanel.vue");
  assert.match(management, /invites\.isLoading\.value[^>]*role="status"/);
  assert.match(management, /bindings\.isLoading\.value[^>]*role="status"/);
  assert.match(management, /v-else class="proxy-empty"[^>]*>\{\{ t\("settings\.controlPlaneProxy\.noInvites"\)/);
  assert.match(management, /v-else class="proxy-empty"[^>]*>\{\{ t\("settings\.controlPlaneProxy\.noBindings"\)/);
  assert.match(management, /GeneratedTokenDialog[\s\S]*generatedInvite\.invite\.expiresAt[\s\S]*generatedInvite\.token/);
  assert.match(management, /inviteStatus\.\$\{invite\.status\}/);
  assert.match(read("src/i18n/locales/en-US/settings.ts"), /expired: "Expired"/);
});

test("offline proxy state remains layered instead of overwriting the last target state", () => {
  const target = { id: "node-b", name: "B", status: "offline", health: "failed", capabilities: {} };
  const state = proxyPathState({
    proxyState: {
      reachability: "unreachable",
      bindingStatus: "active",
      bindingRevision: 4,
      revision: 9,
      target,
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.equal(state.proxy, "unreachable");
  assert.equal(state.binding, "active");
  assert.equal(state.target, target);
  assert.equal(state.revision, 9);
});

test("proxy management lists own bounded themed overflow without truncating identifiers", () => {
  const management = read("src/apps/control-plane/settings/ControlPlaneProxyManagementPanel.vue");
  assert.match(management, /<ScrollArea v-else-if="nodeInvites\.length" class="proxy-list" :horizontal="false">/);
  assert.match(management, /<ScrollArea v-else-if="nodeBindings\.length" class="proxy-list" :horizontal="false">/);
  assert.match(management, /\.proxy-list\s*\{\s*max-height: min\(260px,/);
  assert.match(management, /\.proxy-row strong,\s*\.proxy-row span,\s*\.proxy-row code\s*\{[\s\S]*?overflow-wrap: anywhere;/);
  assert.doesNotMatch(management, /\.proxy-list[^}]*overflow:\s*auto/);
});

test("every remote-node dialog close path clears the proxy invite secret", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /function setRemoteNodeDialogOpen\(open: boolean\)[\s\S]*proxyNodeDraft\.value = \{ proxyOrigin: "", inviteToken: "", name: "", trusted: false \}/);
  assert.match(settings, /await createSettingsNode\(\);[\s\S]*if \(settingsNodeSuccess\.value\) \{\s*setRemoteNodeDialogOpen\(false\)/);
  assert.doesNotMatch(settings, /remoteNodeDialogOpen\.value = false/);
});

test("proxy management query failures never masquerade as empty or zero activity", () => {
  const management = read("src/apps/control-plane/settings/ControlPlaneProxyManagementPanel.vue");
  assert.match(management, /invites\.isLoading\.value \|\| invites\.error\.value \? t\("settings\.controlPlaneProxy\.invitesTitle"\)/);
  assert.match(management, /bindings\.isLoading\.value \|\| bindings\.error\.value \? t\("settings\.controlPlaneProxy\.bindingsTitle"\)/);
  assert.match(management, /v-else-if="invites\.error\.value" class="proxy-query-error" role="alert"/);
  assert.match(management, /v-else-if="bindings\.error\.value" class="proxy-query-error" role="alert"/);
  assert.match(management, /diagnostics\.isLoading\.value[\s\S]*settings\.nodeDetail\.loading/);
  assert.match(management, /diagnostics\.error\.value[\s\S]*activityUnavailable/);
  assert.match(management, /diagnostics\.refetch\(\)/);
});

test("pending claims serialize actions and remain reachable inside a bounded ScrollArea", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /<ScrollArea class="pending-proxy-list" :horizontal="false">/);
  assert.match(settings, /\.pending-proxy-list \{ max-height: min\(220px, max\(96px, calc\(100dvh - 430px\)\)\); \}/);
  assert.match(settings, /:disabled="Boolean\(pendingClaimBusyId\)"/);
  assert.match(settings, /async function resumeProxyClaim\(id: string\) \{\s*if \(pendingClaimBusyId\.value\) return;/);
  assert.match(settings, /async function cancelProxyClaim\(id: string\) \{\s*if \(pendingClaimBusyId\.value\) return;/);
  assert.match(settings, /finally \{[\s\S]*pendingClaimBusyId\.value = "";[\s\S]*pendingClaimAction\.value = undefined;/);
});

test("proxy invite input is masked by default with an accessible reveal control", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /:type="showProxyInviteToken \? 'text' : 'password'"/);
  assert.match(settings, /EyeOff v-if="showProxyInviteToken"/);
  assert.match(settings, /<Eye v-else/);
  assert.match(settings, /:aria-pressed="showProxyInviteToken"/);
  assert.match(settings, /settings\.controlPlaneProxy\.hideToken[\s\S]*settings\.controlPlaneProxy\.showToken/);
  assert.match(settings, /showProxyInviteToken\.value = false/);
});

test("pending claim cancellation uses the backend compensation result contract", () => {
  const queries = read("src/api/queries.ts");
  const types = read("src/api/types.ts");
  assert.match(queries, /deleteApiData<CancelProxyClaimResult>/);
  assert.match(types, /export type CancelProxyClaimResult = \{[\s\S]*deleted: boolean;[\s\S]*compensationRequired: boolean;[\s\S]*remoteRevoke:/);
  assert.doesNotMatch(queries, /\{ cancelled: boolean \}/);
});

test("proxy dialogs preserve keyboard submit, cancel, focus, and destructive confirmation semantics", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const management = read("src/apps/control-plane/settings/ControlPlaneProxyManagementPanel.vue");
  const remoteDialog = settings.match(/<Dialog :open="remoteNodeDialogOpen"[\s\S]*?<\/Dialog>/)?.[0] || "";
  assert.match(remoteDialog, /<form class="remote-node-form" @submit\.prevent="submitRemoteNode">/);
  assert.match(remoteDialog, /<Tabs v-model="remoteNodeMode" class="remote-node-tabs">[\s\S]*<TabsTrigger value="direct"[\s\S]*<TabsTrigger value="control-plane-proxy"/);
  assert.match(remoteDialog, /<Button type="button" variant="outline"[^>]*setRemoteNodeDialogOpen\(false\)/);
  assert.match(remoteDialog, /<Button type="submit"/);
  assert.doesNotMatch(remoteDialog, /@(?:open|close)-auto-focus\.prevent/);
  assert.match(management, /<AlertDialog[\s\S]*<AlertDialogCancel>[\s\S]*<AlertDialogAction/);
  assert.match(management, /size="icon-sm" :aria-label="t\('settings\.controlPlaneProxy\.revokeInvite'\)"/);
  assert.match(management, /size="icon-sm" :aria-label="t\('settings\.controlPlaneProxy\.revokeBinding'\)"/);
});

test("proxy claim validation errors are associated with the exact invalid control", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /proxyNodeErrorField === 'origin' \? 'proxy-node-error'/);
  assert.match(settings, /proxyNodeErrorField === 'token' \? 'proxy-node-error'/);
  assert.match(settings, /proxyNodeErrorField === 'trust' \? 'proxy-node-error'/);
  assert.match(settings, /:aria-invalid="proxyNodeErrorField === 'origin'"/);
  assert.match(settings, /:aria-invalid="proxyNodeErrorField === 'token'"/);
  assert.match(settings, /:aria-invalid="proxyNodeErrorField === 'trust'"/);
  assert.match(settings, /id="proxy-node-error" class="control-plane-error" role="alert"/);
  assert.match(settings, /proxyNodeErrorField\.value = issue \|\| "form"/);
});
