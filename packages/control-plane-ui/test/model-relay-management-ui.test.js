import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const modelSettings = fs.readFileSync(new URL("../src/apps/control-plane/settings/ModelSettingsSection.vue", import.meta.url), "utf8");
const modelEntryList = fs.readFileSync(new URL("../src/apps/control-plane/settings/ModelEntryList.vue", import.meta.url), "utf8");
const modelSettingsComposable = fs.readFileSync(new URL("../src/apps/control-plane/settings/useModelSettings.ts", import.meta.url), "utf8");
const nodeDetail = fs.readFileSync(new URL("../src/apps/control-plane/settings/NodeDetailPanel.vue", import.meta.url), "utf8");
const settingsModal = fs.readFileSync(new URL("../src/apps/control-plane/settings/SettingsModal.vue", import.meta.url), "utf8");
const zhSettings = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/settings.ts", import.meta.url), "utf8");
const enSettings = fs.readFileSync(new URL("../src/i18n/locales/en-US/settings.ts", import.meta.url), "utf8");

test("model editor exposes external and upstream name fields per entry", () => {
  assert.match(modelSettings, /settings\.modelRegistry\.externalName/);
  assert.match(modelEntryList, /<ControlPlaneInput v-model="entry\.name"/);
  assert.match(modelSettings, /settings\.modelRegistry\.upstreamName/);
  assert.match(modelEntryList, /<ControlPlaneInput v-model="entry\.upstreamName"/);
  // Discovered ids initialize both fields before the external name is edited.
  assert.match(modelSettings, /empty\.name = value;\s*empty\.upstreamName = value;/);
  assert.match(modelSettings, /push\(\{ name: value, upstreamName: value, order:/);
  // The composer resolves every row through the shared upstream-name helper on save.
  assert.match(modelSettingsComposable, /export function modelUpstreamName\(entry: \{ name: string; upstreamName\?: string \}\)/);
  assert.match(modelSettingsComposable, /return entry\.upstreamName\?\.trim\(\) \|\| entry\.name\.trim\(\);/);
  assert.match(modelSettingsComposable, /upstreamName: modelUpstreamName\(entry\),/);
});

test("model name fields stay at the 12px body metric and keep secondary weight", () => {
  assert.match(modelEntryList, /\.model-entry-field > span \{[^}]*font-size: 12px;[^}]*font-weight: 400;/);
  assert.doesNotMatch(modelEntryList, /\.model-entry-field[^{]*\{[^}]*font-size: 1[01]px/);
});

test("node detail renders the relay switch from the authoritative response", () => {
  assert.match(nodeDetail, /settings\.nodeDetail\.modelRelay/);
  assert.match(nodeDetail, /:model-value="resources\.modelRelay\?\.enabled === true"/);
  assert.match(nodeDetail, /actions\.setModelRelayEnabled\(value === true\)/);
  assert.match(nodeDetail, /settings\.nodeDetail\.modelRelayDefaultHint/);
  assert.match(nodeDetail, /settings\.nodeDetail\.modelRelayUnsupported/);
  assert.match(nodeDetail, /resources\.modelRelaySupported/);
});

test("node relay state loads and saves through the API without a local write", () => {
  assert.match(settingsModal, /getNodeModelRelay\(node\.id\)/);
  assert.match(settingsModal, /modelRelay\.value = await updateNodeModelRelay\(node\.id, \{ enabled \}\)/);
  assert.match(settingsModal, /modelRelayInUseInstances/);
  assert.doesNotMatch(settingsModal, /modelRelay\.value = \{ enabled/);
  assert.match(settingsModal, /void loadModelRelay\(\)/);
});

test("relay copy ships in both locales", () => {
  for (const locale of [zhSettings, enSettings]) {
    for (const key of ["modelRelay:", "modelRelayDescription:", "modelRelayDefaultHint:", "modelRelayUnsupported:", "externalName:", "upstreamName:"]) {
      assert.ok(locale.includes(key), `missing ${key}`);
    }
  }
});

test("session selectors consume only the shared external-name directory", () => {
  const selection = fs.readFileSync(new URL("../src/components/models/ModelEntitySelection.vue", import.meta.url), "utf8");
  assert.doesNotMatch(selection, /upstreamName/);
  const mobileMenu = fs.readFileSync(new URL("../../../apps/mobile/src/ai-sessions/model-settings-menu.ts", import.meta.url), "utf8");
  assert.doesNotMatch(mobileMenu, /upstreamName/);
});

test("narrow layout stacks the name fields instead of overflowing", () => {
  assert.match(modelEntryList, /@media\(max-width:560px\) \{[\s\S]*grid-template-columns: 32px minmax\(0,1fr\) auto;[\s\S]*\.model-entry-field:last-of-type \{ grid-row: 2; \}/);
  assert.match(modelEntryList, /\.model-entry-delete \{ grid-column: 3; grid-row: 1; \}/);
});
