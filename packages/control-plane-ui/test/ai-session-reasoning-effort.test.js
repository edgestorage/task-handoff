import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const modelMenu = fs.readFileSync(new URL("../src/components/ai-session/AiSessionModelMenu.vue", import.meta.url), "utf8");
const reasoningEfforts = fs.readFileSync(new URL("../src/components/ai-session/aiSessionReasoningEfforts.ts", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const agentEditor = fs.readFileSync(new URL("../src/apps/control-plane/agent/AgentEditor.vue", import.meta.url), "utf8");

test("shared model menu appends the reasoning effort submenu after provider models", () => {
  const providers = modelMenu.indexOf('v-for="group in modelGroups"');
  const separator = modelMenu.indexOf("<DropdownMenuSeparator />", providers);
  const reasoning = modelMenu.indexOf('t("sessions.composer.reasoningEffort")', separator);

  assert.ok(providers >= 0);
  assert.ok(separator > providers);
  assert.ok(reasoning > separator);
  assert.match(modelMenu, /reasoningEffort === effort/);
  assert.match(modelMenu, /DropdownMenuSubContent/);
  // 档位枚举只在协议 schema 里定义一次，UI 不复写列表。
  assert.match(reasoningEfforts, /AI_SESSION_REASONING_EFFORTS: readonly AiSessionReasoningEffort\[\] = AiSessionReasoningEffortSchema\.options;/);
  assert.match(reasoningEfforts, /effort !== "ultra"/);
});

test("composer and agent editor share the same model menu", () => {
  for (const [name, source] of Object.entries({ "AiSessionComposer.vue": composer, "AgentEditor.vue": agentEditor })) {
    assert.match(source, /<AiSessionModelMenu\s/, `${name} must use the shared model menu`);
    assert.doesNotMatch(source, /ai-session-model-menu__item/, `${name} must not re-implement the model menu markup`);
  }
  assert.match(composer, /:model-selection="displayedModelSelection"[\s\S]*@select-model="emit\('selectModel', \$event\)"/);
  assert.match(agentEditor, /:model-groups="modelGroups"[\s\S]*@select-model="selectModel"/);
});

test("model trigger tooltip summarizes the selected provider, model, and reasoning effort", () => {
  assert.match(composer, /<TooltipContent class="ai-session-model-summary-tooltip"[\s\S]*displayedProviderName[\s\S]*displayedModelName[\s\S]*reasoningEffort/);
  // The stored selection is matched to a catalog option by its stable identity,
  // so a renamed display label still resolves to the same option.
  assert.match(composer, /modelOptions\.value\.find\(\(model\) => sameModelSelectionRef\(model, selection\)\)/);
  assert.match(composer, /sessions\.composer\.selectionNotSet/);
  assert.match(composer, /<DropdownMenu[^>]*@update:open="updateModelMenuOpen">\s*<DropdownMenuTrigger as-child>\s*<button/);
  assert.match(composer, /<Tooltip :open="modelSummaryTooltipOpen">[\s\S]*<TooltipTrigger\s*:reference="modelTriggerEl"/);
  assert.doesNotMatch(composer, /<TooltipTrigger as-child>[\s\S]{0,120}<DropdownMenuTrigger/);
  assert.match(composer, /@pointerenter="showModelSummaryTooltip"/);
  assert.doesNotMatch(composer, /@focus="showModelSummaryTooltip"/);
});

test("new and existing sessions use the same reasoning effort composer control", () => {
  assert.match(panel, /:reasoning-effort="newSessionReasoningEffort"/);
  assert.match(panel, /@select-reasoning-effort="selectNewSessionReasoningEffort"/);
  assert.match(panel, /selectedSession\.reasoningEffort \|\| \(selectedSession\.agent === 'codex' \? AI_SESSION_DEFAULT_REASONING_EFFORT : undefined\)/);
  assert.match(panel, /newSessionReasoningEffort = ref<AiSessionReasoningEffort>\(AI_SESSION_DEFAULT_REASONING_EFFORT\)/);
  assert.match(panel, /@select-reasoning-effort="selectExistingSessionReasoningEffort"/);
  assert.match(panel, /updateAiSessionReasoningEffort/);
  assert.match(panel, /persistAiSessionCreationPreferences\(session\.agent, \{ reasoningEffort \}\)/);
});
