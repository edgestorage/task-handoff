import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("node detail tabs reuse the shared settings directory list pattern", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");

  // Section cards own the border and keep the header flush with the card edge.
  assert.match(panel, /\.node-detail-section,\s*\n\.node-remote-panel\s*\{[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s);

  // Directory header: full-bleed divider, strong 13px title. Text-only headers
  // keep the shared 38px bar; only headers that carry a button or select add
  // 8px vertical padding so the control clears the divider on both sides.
  assert.match(panel, /\.section-head\s*\{[^}]*min-height:\s*38px;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*padding:\s*0 12px;/s);
  assert.match(panel, /\.section-head\.has-actions\s*\{\s*padding:\s*8px 12px;\s*\}/);
  assert.match(panel, /\.section-head > span\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*var\(--node-detail-section-title-size\);[^}]*font-weight:\s*500;/s);

  // The taller bar is opt-in per header, not a blanket height on every card.
  assert.equal((panel.match(/class="section-head has-actions"/g) || []).length, 6);
  assert.equal((panel.match(/class="section-head"/g) || []).length, 7);
  for (const headingKey of ["managedUpdates", "updateJobs", "localFolderCount", "dockerImages", "pairedKeys", "activeConnections"]) {
    assert.match(
      panel,
      new RegExp(`class="section-head has-actions">\\s*<span>\\{\\{ t\\("settings\\.nodeDetail\\.${headingKey}"`),
      `expected has-actions on the ${headingKey} header`,
    );
  }

  // Updates renders with the same cards as every other tab instead of a
  // bespoke group rail, and keeps its explanatory copy in a shared note row.
  assert.doesNotMatch(panel, /managed-update-group/);
  assert.match(panel, /\.section-note\s*\{[^}]*padding:\s*9px 12px 10px;/s);

  // Rows: full-bleed separators with 12px horizontal padding and no extra gaps.
  assert.match(panel, /\.node-resource-row\s*\{[^}]*gap:\s*16px;[^}]*padding:\s*10px 12px;/s);
  assert.match(panel, /\.node-resource-row \+ \.node-resource-row\s*\{\s*border-top:\s*1px solid var\(--line\);\s*\}/);
  assert.doesNotMatch(panel, /\n\.node-resource-list\s*\{[^}]*border-top/s);

  // Lists scroll with the single outer ScrollArea instead of nesting their own.
  assert.equal((panel.match(/<ScrollArea/g) || []).length, 1);
  assert.doesNotMatch(panel, /compact-list|settings-scroll-content/);

  // Non-list section content keeps a single padded body wrapper.
  assert.match(panel, /\.node-detail-section-body\s*\{[^}]*display:\s*grid;[^}]*gap:\s*10px;[^}]*padding:\s*12px;/s);
});

test("cloud relay panels keep a standalone card layout and support an embedded mode", () => {
  const bind = read("src/apps/control-plane/settings/CloudRelayBindPanel.vue");
  const node = read("src/apps/control-plane/settings/CloudRelayNodePanel.vue");

  for (const component of [bind, node]) {
    assert.match(component, /class="cloud-relay-panel"/);
    assert.match(component, /\.cloud-relay-panel\s*\{[^}]*border: 1px solid var\(--line\);[^}]*border-radius: 8px;[^}]*background: var\(--surface-raised\);/s);
    assert.match(component, /:class="\{ 'cloud-relay-panel-embedded': embedded \}"/);
    assert.match(component, /\.cloud-relay-panel-embedded\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    assert.match(component, /\.cloud-relay-panel-head\s*\{[^}]*border-bottom: 1px solid var\(--line\);[^}]*padding: 8px 12px;/s);
    assert.doesNotMatch(component, /node-remote-panel|class="section-head/);
  }

  assert.match(bind, /cloudRelayBindRequiresScope/);
  assert.match(node, /\.cloud-relay-panel-row\s*\{[^}]*padding: 10px 12px;/s);
});

test("cloud node trust lists active control planes and revokes with revision fencing", () => {
  const trust = read("src/apps/control-plane/settings/CloudNodeTrustPanel.vue");
  const detail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const relay = read("src/apps/control-plane/settings/CloudRelayNodePanel.vue");
  const english = read("src/i18n/locales/en-US/settings.ts");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");

  assert.match(detail, /CLOUD_ACCOUNT_NODE_HANDLE_LABEL/);
  assert.match(detail, /connectionPath\?\.kind === "cloud-relay"/);
  assert.match(detail, /canManageSettings: boolean/);
  assert.match(detail, /showCloudNodeTrust = computed\(\(\) => props\.canManageSettings && Boolean/);
  assert.match(settings, /<NodeDetailPanel[\s\S]*:can-manage-settings="canManageSettings"/);
  assert.equal((detail.match(/class="node-cloud-connection-card"/g) || []).length, 2);
  assert.match(detail, /\.node-cloud-connection-card\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid var\(--line\);[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--surface-raised\);/s);
  assert.doesNotMatch(detail, /node-cloud-connection-(?:group|head)|settings\.nodeDetail\.cloudConnection/);
  assert.match(detail, /<CloudRelayNodePanel :selected-node="selectedNode" embedded \/>[\s\S]*<CloudNodeTrustPanel/);
  assert.match(detail, /<CloudRelayBindPanel :selected-node="selectedNode" embedded[^>]*\/>[\s\S]*<CloudNodeTrustPanel/);
  assert.equal((detail.match(/v-if="showCloudNodeTrust"/g) || []).length, 2);
  assert.equal((detail.match(/:can-manage-settings="canManageSettings"/g) || []).length, 2);
  assert.match(trust, /\.cloud-node-trust-panel-embedded\s*\{[^}]*border:\s*0;[^}]*border-top:\s*1px solid var\(--line\);/s);
  assert.doesNotMatch(relay, /nodeControlPlaneTrustQueryOptions|cloudRelayTrust/);
  assert.match(trust, /canManageSettings: boolean/);
  assert.match(trust, /nodeControlPlaneTrustQueryOptions\(props\.selectedNode\.id, props\.canManageSettings\)/);
  assert.match(trust, /\.filter\(\(pin\) => pin\.status === "active"\)/);
  assert.match(trust, /cloudRelayTrustedControlPlanes", \{ count: activePins\.length \}/);
  assert.match(trust, /pin\.controlPlaneId === cloudControlPlaneId\.value/);
  assert.doesNotMatch(trust, /pin\.nodeHandle|pin\.bindingId/);
  assert.match(trust, /:disabled="revokeDisabled\(pin\)"/);
  assert.match(trust, /revokeDisabled\(pin: NodeAgentControlPlaneTrustPin\)[\s\S]*!cloudControlPlaneId\.value \|\| isCurrentPin\(pin\)/);
  assert.match(trust, /function requestRevoke\(pin: NodeAgentControlPlaneTrustPin\) \{\s*if \(revokingId\.value \|\| !cloudControlPlaneId\.value \|\| isCurrentPin\(pin\)\) return;/);
  assert.match(trust, /if \(!target \|\| revokingId\.value \|\| !cloudControlPlaneId\.value \|\| isCurrentPin\(target\.pin\)\) return;/);
  assert.match(trust, /revokeNodeControlPlaneTrust\(targetNodeId, targetPin\.pinId/);
  assert.match(trust, /expectedFingerprint: targetPin\.fingerprint/);
  assert.match(trust, /expectedRevision: targetPin\.revision/);
  assert.match(trust, /nodeId: props\.selectedNode\.id, pin/);

  for (const key of ["cloudRelayTrustedControlPlanes", "cloudRelayTrustEmpty", "cloudRelayTrustCurrent", "cloudRelayTrustCurrentHint", "cloudRelayTrustCurrentUnknownHint", "cloudRelayTrustRevokeTitle", "cloudRelayTrustRevokeDescription", "cloudRelayTrustRevokeDone", "cloudRelayTrustRevokeFailed"]) {
    assert.match(english, new RegExp(`${key}:`));
    assert.match(chinese, new RegExp(`${key}:`));
  }
  assert.doesNotMatch(english, /cloudConnection:/);
  assert.doesNotMatch(chinese, /cloudConnection:/);
});

test("cloud permission copy exposes an inline node picker", () => {
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  const english = read("src/i18n/locales/en-US/settings.ts");

  assert.match(chinese, /scopesTitle: "云平台权限"/);
  assert.match(chinese, /nodeListTitle: "当前控制面节点"/);
  assert.match(chinese, /nodeAddAndEnable: "开启权限并添加"/);
  assert.match(chinese, /cloudRelayBindAction: "添加到云平台"/);
  assert.match(english, /scopesTitle: "Cloud permissions"/);
  assert.match(english, /nodeListTitle: "Nodes in this Control Plane"/);
  assert.match(english, /nodeAddAndEnable: "Enable access and add"/);
  assert.match(english, /cloudRelayBindAction: "Add to cloud"/);
});
