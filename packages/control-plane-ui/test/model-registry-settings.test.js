import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("model queries preserve the federated registry and expose a flattened compatibility view", () => {
  const queries = read("src/api/queries.ts");
  assert.match(queries, /function useModelRegistryQuery/);
  assert.match(queries, /queryFn: \(\{ signal \}\) => fetchModelRegistry\(signal\)/);
  assert.match(queries, /select: modelConfigsFromRegistry/);
  assert.match(queries, /locations: group\.locations/);
  assert.match(queries, /referenceCount: group\.referenceCount/);
});

test("models settings exposes location scope, references, and node diagnostics", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  for (const contract of [
    /v-model="settingsModel\.locationScope"/,
    /t\("settings\.modelRegistry\.controlPlane"\)/,
    /t\("settings\.modelRegistry\.nodeLocation", \{ name: node\.name \}\)/,
    /model\.locations/,
    /referenceCount/,
    /nodeDiagnostics/,
    /model-diagnostics/,
  ]) assert.match(settings, contract);
});

test("model edits use one authoritative call and report per-location sync state", () => {
  const settings = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(settings, /const result = await updateModel\(editingModelId\.value, payload\)/);
  assert.match(settings, /result\.locations\.filter\(\(location\) => location\.state !== "synced"\)/);
  assert.match(settings, /syncModelRequest\(model\.id\)/);
  assert.match(settings, /mergeModelRequest\(model\.id, targetModelId\)/);
  assert.match(settings, /function staleLocations\(model: ModelConfig\)/);
  assert.match(settings, /function mergeCandidates\(model: ModelConfig\)/);
  assert.match(settings, /createNodeModel\(settingsModel\.locationScope/);
  assert.match(settings, /deleteNodeModel\(location\.nodeId/);
  assert.match(settings, /removeModel\(model: ModelConfig, location: ModelLocation\)/);
  assert.match(settings, /settingsModel\.locationScope === "control-plane"/);
  assert.match(settings, /finally \{\s*savingModelId\.value = ""/);
  assert.match(settings, /finally \{\s*deletingModelId\.value = ""/);
  assert.doesNotMatch(settings, /Promise\.allSettled\(locations\.map/);
  assert.doesNotMatch(settings, /updateNodeModel\(/);
});

test("model settings surface pending node sync and merge actions", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /staleLocations\(model\)\.length/);
  assert.match(settings, /@select="syncModelLocations\(model\)"/);
  assert.match(settings, /@select="requestMerge\(model, candidate\)"/);
  assert.match(settings, /class="model-location-stale"/);
  assert.match(settings, /pendingMerge/);
});

test("models settings edits aggregate entries and deletes explicit locations through a portal menu", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /t\("settings\.modelRegistry\.editDescription"/);
  assert.match(settings, /t\("settings\.modelRegistry\.allLocations", \{ count: editingModelLocationCount \}\)/);
  assert.match(settings, /<DropdownMenuSubContent class="model-delete-location-menu"/);
  assert.match(settings, /v-for="location in model\.locations/);
  assert.match(settings, /@select="requestDelete\(model, location\)"/);
  assert.match(settings, /location\.type === 'node' && location\.referenceCount > 0/);
});

test("model deletion keeps its target until the asynchronous request completes", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /<AlertDialogCancel :disabled="Boolean\(deletingModelId\)">/);
  assert.match(settings, /<Button variant="destructive" size="sm" :disabled="Boolean\(deletingModelId\)" @click="confirmDelete">/);
  assert.doesNotMatch(settings, /<AlertDialogAction[^>]*@click="confirmDelete"/);
  assert.match(settings, /if \(await removeModel\(target\.model, target\.location\)\) pendingDelete\.value = undefined/);
});

test("model settings discovers models into an ordered name list with real endpoint testing", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const list = read("src/apps/control-plane/settings/ModelEntryList.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(settings, /<ModelEntryList[\s\S]{0,240}:entries="settingsModel\.modelNames"/);
  assert.match(settings, /:external-label="t\('settings\.modelRegistry\.externalName'\)"/);
  assert.match(settings, /:upstream-label="t\('settings\.modelRegistry\.upstreamName'\)"/);
  assert.match(settings, /:upstream-placeholder="modelNameUpstreamPlaceholder"/);
  assert.match(settings, /function modelNameUpstreamPlaceholder\(entry: \{ name: string \}\)/);
  assert.match(settings, /@remove="removeModelName"/);
  assert.match(settings, /@move="moveModelName"/);
  assert.match(settings, /@reorder="reorderModelName"/);
  assert.match(list, /v-for="\(entry, index\) in entries"/);
  assert.match(list, /<ControlPlaneInput v-model="entry\.name"/);
  assert.match(list, /class="model-entry-drag-handle"\s+draggable="true"/);
  assert.match(list, /<TransitionGroup name="model-entry-row" tag="div" class="model-entry-items"[^>]*>/);
  assert.match(list, /:key="entryKey\(entry\)"/);
  assert.match(list, /\.model-entry-row-move \{ transition: transform 180ms ease/);
  assert.match(list, /\.model-entry-row-dragging \{ opacity: 0; \}/);
  assert.match(list, /@dragstart="startDrag\(\$event, index\)"/);
  assert.match(list, /@dragover\.prevent="previewDrag\(\$event, index\)"/);
  assert.match(list, /@drop\.prevent="commitDrag"/);
  assert.match(list, /function dragStyle\(index: number\)/);
  assert.match(list, /emit\("reorder", sourceIndex, targetIndex\)/);
  assert.match(list, /dragSettling\.value = true;[\s\S]*requestAnimationFrame\(\(\) => \{ dragSettling\.value = false; \}\)/);
  assert.match(list, /\.model-entry-items-settling \.model-entry-row \{ transition: none; \}/);
  assert.match(state, /function reorderModelName\(source: number, target: number\)/);
  assert.match(state, /function moveModelName\(index: number, direction: -1 \| 1\)/);
  assert.match(list, /:open="openMenuKey === entryKey\(entry\)"/);
  assert.match(list, /@click="toggleMenu\(\$event, entryKey\(entry\)\)"/);
  assert.match(list, /<DropdownMenuContent align="start"[\s\S]*moveUpLabel[\s\S]*moveDownLabel/);
  assert.match(list, /@keydown\.capture="handleHandleKeydown\(\$event, index, entryKey\(entry\)\)"/);
  assert.match(list, /<GripVertical :size="18"/);
  // One shared column header replaces per-row labels; compact layouts fall back to labels.
  assert.match(list, /<div v-if="entries\.length" class="model-entry-columns" aria-hidden="true">[\s\S]{0,220}externalLabel[\s\S]{0,220}upstreamLabel/);
  assert.match(list, /<span class="model-entry-field-label">\{\{ externalLabel \}\}<\/span>/);
  assert.match(list, /<span class="model-entry-field-label">\{\{ upstreamLabel \}\}<\/span>/);
  assert.match(list, /\.model-entry-columns \{[^}]*grid-template-columns: 32px minmax\(0,1fr\) minmax\(0,1fr\) 36px; \}/);
  assert.match(list, /\.model-entry-field-label \{ display: none; \}/);
  assert.match(list, /@media\(max-width:560px\) \{[\s\S]*\.model-entry-columns \{ display: none; \}[\s\S]*\.model-entry-field-label \{ display: block; \}/);
  assert.doesNotMatch(settings, /model-name-row|model-name-columns|model-name-drag-handle/);
  assert.doesNotMatch(settings, /<ControlPlaneInput v-model="settingsModel\.model"/);
  assert.match(settings, /<PopoverContent class="model-picker-popover [^"]*p-1"[\s\S]*:collision-padding="12"/);
  assert.match(settings, /<Command class="model-picker-command"[\s\S]*<CommandInput class="model-picker-search-input [^"]*text-\[13px\]" :placeholder="t\('settings\.modelRegistry\.searchModels'\)"/);
  assert.match(settings, /<ScrollArea class="model-picker-scroll" :horizontal="false">[\s\S]*<CommandList class="model-picker-list" :scrollable="false">/);
  assert.match(settings, /v-for="option in discoveredModels"/);
  assert.match(settings, /<span>\{\{ option\.id \}\}<\/span>[\s\S]*<Check :size="14"/);
  assert.match(settings, /:global\(\.model-picker-popover\) \{[\s\S]*height: min\(360px,var\(--reka-popover-content-available-height\)\);[\s\S]*overflow: hidden;[\s\S]*padding: 4px;/);
  assert.match(settings, /\.model-picker-command \{[\s\S]*grid-template-rows: auto minmax\(0,1fr\);/);
  assert.match(settings, /\.model-picker-scroll \{ min-height: 0; \}/);
  assert.match(settings, /:deep\(\[role="option"\]\) \{[^}]*font-size: 13px;/);
  // Bounded option track: an unbounded auto column sizes to the widest discovered
  // model id, and the group's overflow-hidden then clips the trailing check icon.
  assert.match(settings, /:deep\(\[role="group"\]\) \{ display: grid; gap: 2px; grid-template-columns: minmax\(0,1fr\); padding: 0; \}/);
  assert.doesNotMatch(settings, /\[cmdk-item\]/);
  assert.match(settings, /@update:open="handleModelPickerOpen"/);
  assert.match(settings, /if \(open && !discoveredModels\.value\.length && !discoveringModels\.value\) void fetchModelOptions\(\)/);
  assert.match(settings, /@click="checkModel"/);
  assert.match(state, /discoverModels\(endpointDraft\(\), endpointNodeId\(\)\)/);
  assert.match(state, /testModel\(\{/);
  assert.match(state, /modelNames: settingsModel\.modelNames\.map/);
  assert.match(state, /model: settingsModel\.modelNames\[0\]\?\.name\.trim\(\) \|\| ""/);
  assert.match(state, /existingModelId: editingModelId\.value \|\| copyingModelId\.value/);
  assert.match(state, /showControlPlaneToast\(t\("settings\.modelRegistry\.testSucceeded"[^;]+"success"\)/);
  assert.match(state, /showDelayedControlPlaneLoadingToast\(t\("settings\.modelRegistry\.testing"\)\)/);
  assert.match(state, /showDelayedControlPlaneLoadingToast\(t\("settings\.modelRegistry\.discovering"\)\)/);
  assert.doesNotMatch(settings, /modelEndpointFeedback/);
});

test("model settings owns endpoint protocols independently from consuming apps", () => {
  const section = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  assert.match(section, /modelProtocols = \["openai-responses", "openai-chat-completions", "anthropic-messages"\]/);
  assert.match(section, /settings\.fields\.endpoint[\s\S]*class="model-protocol-field" role="group"[\s\S]*settings\.fields\.apiKey/);
  assert.match(section, /<ToggleGroup class="model-protocol-options" type="multiple"/);
  assert.match(section, /<ToggleGroupItem v-for="protocol in modelProtocols"/);
  assert.match(section, /settingsModel\.protocols\.includes\(protocol\)/);
  assert.match(section, /\.model-protocol-options \{[^}]*grid-template-columns: repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(section, /\.model-protocol-options \{[^}]*gap: 8px;/);
  assert.match(section, /\.model-protocol-options :deep\(\.model-protocol-option\) \{[^}]*border-radius: 6px;[^}]*min-height: 58px;[^}]*padding: 5px 8px;/);
  assert.match(section, /\.model-protocol-copy strong \{[^}]*font-size: 13px;[^}]*font-weight: 500;/);
  assert.match(section, /\.model-protocol-copy small \{[^}]*font-size: 12px;[^}]*font-weight: 400;/);
  assert.match(section, /\.model-protocol-copy \{[^}]*position: relative;[^}]*width: 100%;/);
  assert.match(section, /\.model-protocol-check \{[^}]*position: absolute;[^}]*right: 0;[^}]*top: 0;/);
  assert.doesNotMatch(section, /class="model-form-grid"/);
  assert.match(state, /function setProtocols\(values: unknown\)/);
  assert.match(state, /Promise\.all\(settingsModel\.protocols\.map\(\(protocol\) => testModel/);
  assert.match(state, /protocols: \[\.\.\.settingsModel\.protocols\]/);
});

test("only control-plane model locations expose secret-preserving copy", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  const queries = read("src/api/queries.ts");
  assert.match(settings, /v-if="model\.locations\?\.some\(\(location\) => location\.type === 'control-plane'\)" @select="openCopyDialog\(model\)"/);
  assert.match(settings, /v-else-if="copyingModelId" class="model-scope-notice"/);
  assert.match(state, /function copyModelDraft\(model: ModelConfig\)/);
  assert.match(state, /saved = await copyModel\(copyingModelId\.value, payload\)/);
  assert.match(state, /source\.endpoint === settingsModel\.endpoint\.trim\(\)[\s\S]*source\.model === settingsModel\.model\.trim\(\)/);
  assert.doesNotMatch(state, /sourceProtocols/);
  assert.match(queries, /postApiData<ModelConfig>\(`models\/\$\{id\}\/copy`, input\)/);
});

test("models settings uses a full-width directory and a guarded editor dialog", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /class="model-toolbar"/);
  assert.match(settings, /const filteredModels = computed/);
  assert.match(settings, /<Dialog :open="editorOpen"/);
  assert.match(settings, /<DialogHeader class="model-editor-head space-y-0">/);
  assert.match(settings, /modelDraftDirty/);
  assert.match(settings, /model-editor-dialog w-\[min\(680px,calc\(100vw-32px\)\)\] max-w-none gap-0 overflow-hidden p-0/);
  assert.match(settings, /closeConfirmationOpen/);
  assert.match(settings, /<AlertDialog :open="Boolean\(pendingDelete\)"/);
  assert.doesNotMatch(settings, /window\.confirm/);
});

test("model locations and references open portal popovers without expanding rows", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  assert.match(settings, /<PopoverContent class="model-summary-popover [^"]*p-0"[\s\S]*settings\.modelRegistry\.locations/);
  assert.match(settings, /settings\.modelRegistry\.referenceDistribution/);
  assert.match(settings, /function referenceLocations\(model: ModelConfig\)/);
  assert.match(settings, /--reka-popover-content-available-height/);
  assert.doesNotMatch(settings, /expandedModelIds|model-location-panel/);
});

test("model reference distribution expands node instances and opens their model settings", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  const zh = read("src/i18n/locales/zh-CN/settings.ts");
  const en = read("src/i18n/locales/en-US/settings.ts");
  assert.match(settings, /defineProps<\{ instances\?: InstanceBoardItem\[\] \}>\(\)/);
  assert.match(settings, /defineEmits<\{ openInstanceSettings: \[instanceId: string, section: "models"\] \}>\(\)/);
  assert.match(settings, /:aria-expanded="referenceGroupExpanded\(model\.id, location\)"/);
  assert.match(settings, /@click="toggleReferenceGroup\(model\.id, location\)"/);
  assert.match(settings, /v-for="instance in nodeReferenceInstances\(model, location\)"/);
  assert.match(settings, /@click="openInstanceModelSettings\(instance\)"/);
  assert.match(settings, /emit\("openInstanceSettings", instance\.id, "models"\)/);
  assert.match(settings, /function nodeReferenceInstances\(model: ModelConfig, location: NodeLocation\)/);
  // Legacy replicas are keyed by the content-hash projection, which is only
  // exposed as `replicaId`; the revision is a different (content) value now.
  assert.match(settings, /\[model\.id, model\.revision, location\.revision, location\.replicaId\]/);
  assert.match(settings, /instanceSelectionIds\(instance\.modelSelection\)\.some\(\(id\) => candidateIds\.has\(id\)\)/);
  assert.match(settings, /instance\.nodeId === location\.nodeId/);
  assert.match(settings, /t\("settings\.modelRegistry\.unlistedReferences"/);
  assert.match(settings, /localizedStatus\(instanceStatusKeys, instance\.status\)/);
  assert.match(settings, /\.model-reference-instance > span \{[^}]*font-size: 12px;/);
  assert.match(settings, /\.model-reference-toggle \{ background: transparent; border: 0; cursor: pointer;/);
  assert.match(modal, /<ModelSettingsSection v-else-if="settingsSection === 'models'" :instances="instances" @open-instance-settings="\(instanceId, section\) => emit\('openInstanceSettings', instanceId, section\)"/);
  assert.match(modal, /openInstanceSettings: \[instanceId: string, section\?: "general" \| "ai" \| "codex" \| "models" \| "git-credentials" \| "apps"\]/);
  for (const locale of [zh, en]) {
    assert.match(locale, /openInstanceSettings: "/);
    assert.match(locale, /unlistedReferences: "/);
  }
});

test("model request mappings stay independent, preset-driven, and hint relay dependency", () => {
  const settings = read("src/apps/control-plane/settings/ModelSettingsSection.vue");
  const list = read("src/apps/control-plane/settings/ModelEntryList.vue");
  const state = read("src/apps/control-plane/settings/useModelSettings.ts");
  const capabilities = read("src/api/nodeCapabilities.ts");
  const zh = read("src/i18n/locales/zh-CN/settings.ts");
  const en = read("src/i18n/locales/en-US/settings.ts");

  assert.match(state, /import \{ MODEL_REQUEST_MAPPING_PRESETS \} from "@task-handoff\/protocol\/control-plane"/);
  assert.match(state, /mappings: \[\] as ModelRequestMapping\[\]/);
  assert.match(state, /function addMapping\(\)/);
  assert.match(state, /function removeMapping\(index: number\)/);
  assert.match(state, /function moveMapping\(index: number, direction: -1 \| 1\)/);
  assert.match(state, /function reorderMapping\(source: number, target: number\)/);
  assert.match(state, /function applyMappingPreset\(presetId: string\)/);
  // Presets fill the first upstream name by default and remain editable.
  assert.match(state, /const mappingTargetDefault = \(\) => \{[\s\S]*upstreamName\?\.trim\(\) \|\| primary\?\.name\.trim\(\) \|\| ""/);
  assert.match(state, /const mappingsEditable = computed/);
  assert.match(state, /mappings: settingsModel\.mappings\.map\(\(entry, index\) => \(\{/);
  assert.match(state, /if \(!mappingsEditable\.value && settingsModel\.mappings\.length\) return false/);

  assert.match(capabilities, /supportsNodeModelRequestMappings/);
  assert.match(settings, /:entries="settingsModel\.mappings"/);
  assert.match(settings, /v-for="preset in mappingPresets"/);
  assert.match(settings, /@select="applyMappingPreset\(preset\.id\)"/);
  assert.match(settings, /@click="addMapping"/);
  assert.match(settings, /:row-note="mappingRowNote"/);
  assert.match(settings, /function mappingRowNote\(entry: \{ name: string \}\)/);
  assert.match(settings, /@remove="removeMapping"/);
  assert.match(settings, /@move="moveMapping"/);
  assert.match(settings, /@reorder="reorderMapping"/);
  assert.match(settings, /settings\.modelRegistry\.mappingsRelayHint/);
  assert.match(settings, /settings\.modelRegistry\.mappingsUnsupported/);
  assert.match(settings, /:disabled="!mappingsEditable/);
  // Mappings render through the same ordered list as model names: shared header,
  // grip drag handle, and no per-row labels or arrow column.
  assert.doesNotMatch(settings, /model-mapping-row|model-mapping-arrow|model-mapping-actions/);
  assert.match(list, /class="model-entry-drag-handle"[\s\S]*draggable="true"/);
  assert.match(list, /<span class="model-entry-field-label">\{\{ externalLabel \}\}<\/span>/);

  for (const locale of [zh, en]) {
    assert.match(locale, /mappings: "/);
    assert.match(locale, /mappingsRelayHint: "/);
    assert.match(locale, /mappingsUnsupported: "/);
    assert.match(locale, /"codex-auto-approval": \{ label: "/);
    assert.match(locale, /"codex-background-tasks": \{ label: "/);
  }
});
