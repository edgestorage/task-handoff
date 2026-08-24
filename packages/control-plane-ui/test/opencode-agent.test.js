import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("OpenCode model selection is available for registry, creation, and instance settings", () => {
  assert.match(read("src/apps/control-plane/settings/ModelSettingsSection.vue"), /value="opencode"/);
  assert.match(read("src/apps/control-plane/new-instance/RuntimeStep.vue"), /model\.app === "opencode"/);
  assert.match(read("src/apps/control-plane/new-instance/newInstanceTypes.ts"), /opencodeModelHash\?: string \| null/);
  assert.match(read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue"), /\["codex", "claude", "opencode"\]/);
});

test("OpenCode presentation consumes provider capability and exposes no skip special case", () => {
  const panel = read("src/apps/control-plane/instance-detail/AiSessionPanel.vue");
  assert.match(read("src/components/AiAgentIcon.vue"), /opencodeIcon/);
  assert.match(panel, /directoryAiSessionProviderCapability\(props\.instance\.capabilities, session\.agent\)/);
  assert.match(panel, /capability\.actions\.approvalDecisions/);
  assert.doesNotMatch(panel, /session\.agent === ["']opencode["'].*skip/);
  const mobile = fs.readFileSync(new URL("../../../apps/mobile/src/ai-sessions/SessionWorkspace.tsx", import.meta.url), "utf8");
  assert.match(mobile, /directoryAiSessionProviderCapability\(instanceCapabilities, session\.agent\)/);
  assert.match(mobile, /providerCapability\?\.actions\.approvalDecisions/);
});
