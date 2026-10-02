import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("instance settings is one top-level dialog with three independent entry points", () => {
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const list = read("src/apps/control-plane/instance-list/InstanceList.vue");
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const nodeDetail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");

  assert.match(workbench, /<InstanceSettingsDialog/);
  assert.match(workbench, /v-model:open="instanceSettingsOpen"/);
  assert.match(workbench, /@open-instance-settings="openInstanceSettings"/);
  assert.match(list, /\$emit\('openSettings', instance\.id\)/);
  assert.match(detail, /\$emit\('openSettings', instance\.id\)/);
  assert.match(settings, /openInstanceSettings: \[instanceId: string, section\?: "general" \| "ai" \| "codex" \| "models" \| "git-credentials" \| "apps"\]/);
  assert.match(nodeDetail, /actions\.openInstanceSettings\(instance\.id\)/);
});

test("the instance App menu opens settings directly on app management", () => {
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const preview = read("src/apps/control-plane/instance-detail/SessionPreview.vue");
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");

  assert.match(preview, /t\("sessions\.tabs\.manageApps"\)/);
  assert.match(preview, /\$emit\('openSettings', instance\.id, 'apps'\)/);
  assert.match(detail, /\$emit\('openSettings', instanceId, section\)/);
  assert.match(workbench, /:initial-section="instanceSettingsSection"/);
  assert.match(workbench, /function openInstanceSettings\(instanceId: string, section: "general" \| "ai" \| "browser" \| "codex" \| "models" \| "git-credentials" \| "apps" = "general"\)/);
  assert.match(dialog, /section\.value = props\.initialSection \|\| "general"/);
});

test("instance refreshes do not reset the selected settings tab", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");

  assert.match(dialog, /\[\(\) => props\.open, \(\) => props\.instance\?\.id, \(\) => props\.initialSection\]/);
  assert.match(dialog, /\[\(\) => props\.open, \(\) => props\.instance\?\.id, \(\) => section\.value\]/);
  assert.doesNotMatch(dialog, /\(\) => \[props\.open, props\.instance\?\.id/);
});

test("instance model controls live only in the settings dialog", () => {
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.doesNotMatch(detail, /Codex model|Claude model|updateInstanceModels|detail-model-selectors/);
  assert.match(dialog, /<ModelEntitySelection v-model="modelEntityIds"/);
  assert.match(dialog, /function normalizedSelection\(value: ModelSelection\)/);
  assert.match(dialog, /return \{ modelEntityIds: \[\.\.\.new Set\(ids\)\] \}/);
  assert.match(dialog, /t\("instances\.settings\.modelSelectionDescription"\)/);
  assert.doesNotMatch(dialog, /keyPreview|\.key\b|API key/);
});

test("instance settings exposes general, models, apps, and inventory freshness states", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  for (const section of ["general", "models", "apps"]) assert.match(dialog, new RegExp(`value=\\"${section}\\"`));
  for (const state of ["current", "stale", "not-reported", "empty", "degraded"]) assert.match(dialog, new RegExp(state));
  assert.match(dialog, /:aria-label="t\('instances\.settings\.sections'\)"/);
  assert.match(dialog, /DialogContent/);
  assert.match(dialog, /ScrollArea/);
  assert.match(dialog, /t\("instances\.settings\.sessionPermissions"\)/);
  assert.match(dialog, /defaultCodexPermissionMode/);
  assert.match(dialog, /t\("instances\.settings\.sessionPermissionsDescription"\)/);
  assert.match(dialog, /t\("instances\.settings\.aiSessionHistoryLimit"\)/);
  assert.match(dialog, /aiSessionHistoryLimit:\s*Number\(aiSessionHistoryLimit\.value\)/);
});

test("instance settings sections use a grouped vertical navigation", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  const zh = read("src/i18n/locales/zh-CN/instances.ts");
  const en = read("src/i18n/locales/en-US/instances.ts");

  assert.match(dialog, /<Tabs\s+v-model="section"\s+orientation="vertical"/);
  assert.match(dialog, /<TabsList class="instance-settings-nav" :aria-label="t\('instances\.settings\.sections'\)">/);
  assert.match(dialog, /class="instance-settings-nav-group-title"/);
  assert.match(dialog, /\.instance-settings-nav \{[\s\S]*?flex-direction: column[\s\S]*?\}/);
  assert.doesNotMatch(dialog, /instance-settings-tabs-list/);
  assert.match(dialog, /\.instance-settings-tabs \{[\s\S]*?grid-template-areas: "nav content"/);
  assert.match(dialog, /<div v-if="instance" class="instance-settings-sidebar">/);
  assert.match(dialog, /class="instance-settings-identity-name">\{\{ instance\.name \}\}/);
  assert.doesNotMatch(dialog.match(/<div class="instance-settings-identity">[\s\S]*?<\/div>/)?.[0] || "", /<Badge/);
  assert.match(dialog, /<DialogDescription id="instance-settings-description" class="sr-only">/);
  assert.match(dialog, /\.instance-settings-close \{[\s\S]*?position: absolute/);
  assert.match(dialog, /<h2 class="instance-settings-content-title">\{\{ activeSectionLabel \}\}<\/h2>/);
  assert.match(dialog, /const activeSectionLabel = computed/);
  for (const group of ["instance", "agent", "provisioning"]) assert.match(dialog, new RegExp(`sectionGroups\\.${group}`));
  for (const locale of [zh, en]) assert.match(locale, /sectionGroups: \{ instance: /);
});

test("instance settings exposes managed Codex behavior and multi-agent defaults", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.match(dialog, /<TabsTrigger value="codex"><AiAgentIcon agent="codex" :size="14" \/>/);
  for (const setting of ["codexVerbosity", "codexPersonality", "codexMultiAgentEnabled", "codexMultiAgentMaxThreads", "codexSubagentModel", "codexSubagentReasoning"]) {
    assert.match(dialog, new RegExp(setting));
  }
  assert.match(dialog, /supportsNodeCodexManagedSettings/);
  assert.match(dialog, /supportsControlledInstanceCodexManagedSettings/);
  assert.match(dialog, /codexSettings: currentCodexSettings\(\)/);
});

test("instance settings configures the ordinary file upload limit through node capability gating", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.match(dialog, /aiSessionFileAttachmentLimit/);
  assert.match(dialog, /aiSessionMaxFileAttachmentKiB/);
  assert.match(dialog, /aiSessionMaxFileAttachmentBytes: Number\(aiSessionMaxFileAttachmentKiB\.value\) \* 1024/);
  assert.match(dialog, /supportsNodeAiSessionFileAttachmentLimit\(nodeCapabilities\)[\s\S]*supportsAiSessionFileSizeLimitSettings\(props\.instance\?\.capabilities\)/);
  assert.match(dialog, /AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES \/ 1024/);
});

test("instance settings edits the instance name through the general settings update", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");

  assert.match(dialog, /<strong>\{\{ t\("instances\.settings\.instanceName"\) \}\}<\/strong>/);
  assert.match(dialog, /<ControlPlaneInput v-model="instanceName"/);
  assert.match(dialog, /if \(generalChanged\.value\) input\.name = instanceName\.value\.trim\(\)/);
  assert.match(dialog, /instanceName\.value\.trim\(\) !== props\.instance\.name/);
});

test("instance settings keeps a stable height within the viewport", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.match(dialog, /height: 680px;/);
  assert.match(dialog, /max-height: calc\(100vh - 36px\);/);
  assert.match(dialog, /\.instance-settings-scroll\s*\{[^}]*height: 100%;/s);
});
