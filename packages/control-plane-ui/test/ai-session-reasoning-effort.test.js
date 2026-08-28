import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");

test("composer appends the reasoning effort submenu after provider models", () => {
  const providers = composer.indexOf('v-for="group in modelGroups"');
  const separator = composer.indexOf('<DropdownMenuSeparator />', providers);
  const reasoning = composer.indexOf('t("sessions.composer.reasoningEffort")', separator);

  assert.ok(providers >= 0);
  assert.ok(separator > providers);
  assert.ok(reasoning > separator);
  assert.match(composer, /\["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"\]/);
  assert.match(composer, /reasoningEffort === effort/);
  assert.match(composer, /DropdownMenuSubContent/);
});

test("new and existing sessions use the same reasoning effort composer control", () => {
  assert.match(panel, /:reasoning-effort="newSessionReasoningEffort"/);
  assert.match(panel, /@select-reasoning-effort="newSessionReasoningEffort = \$event"/);
  assert.match(panel, /selectedSession\.reasoningEffort \|\| \(selectedSession\.agent === 'codex' \? AI_SESSION_DEFAULT_REASONING_EFFORT : undefined\)/);
  assert.match(panel, /newSessionReasoningEffort = ref<AiSessionReasoningEffort>\(AI_SESSION_DEFAULT_REASONING_EFFORT\)/);
  assert.match(panel, /@select-reasoning-effort="selectExistingSessionReasoningEffort"/);
  assert.match(panel, /updateAiSessionReasoningEffort/);
});
