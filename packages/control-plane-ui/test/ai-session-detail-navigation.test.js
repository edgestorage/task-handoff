import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const navigator = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnNavigator.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
const displayHelpers = fs.readFileSync(new URL("../src/apps/control-plane/useInstanceSessions.ts", import.meta.url), "utf8");

test("AI session details expose compact message navigation without a visible label", () => {
  assert.match(navigator, /<small>\{\{ index \+ 1 \}\} \/ \{\{ count \}\}<\/small>/);
  assert.doesNotMatch(navigator, />\s*Turn\b/i);
  assert.match(panel, /<AiSessionTurnNavigator[\s\S]*?:count="promptCount\(selectedSession\)"[\s\S]*?@previous="previousPrompt\(selectedSession\)"[\s\S]*?@next="nextPrompt\(selectedSession\)"/);
  assert.match(floatingDock, /<AiSessionTurnNavigator[\s\S]*?:count="promptCount"[\s\S]*?@previous="\$emit\('previousPrompt'\)"[\s\S]*?@next="\$emit\('nextPrompt'\)"/);
});

test("AI session details render messages without redundant section titles", () => {
  for (const detail of [panel, floatingDock]) {
    assert.doesNotMatch(detail, />\s*User Message\s*</);
    assert.doesNotMatch(detail, />\s*AI Response \/ Progress\s*</);
  }
});

test("cards and details count the same display turns", () => {
  assert.match(panel, /return aiSessionTurns\(session\)\.length;/);
  assert.match(board, /return aiSessionTurns\(session\)\.length;/);
  assert.match(displayHelpers, /const turns = aiSessionDisplayTurns\(session\);[\s\S]*?return turns\[index\]\?\.userPrompt\?\.trim\(\) \|\| "-";/);
});

test("current approval summary remains visible while navigating messages", () => {
  const explicitSelection = displayHelpers.indexOf("if (turns.length && promptIndex !== undefined)");
  const currentApproval = displayHelpers.indexOf('if (session.status === "waiting" && session.phase === "approval"');
  assert.ok(currentApproval >= 0);
  assert.ok(explicitSelection > currentApproval);
});

test("waiting approval state is the only source for approval actions", () => {
  for (const detail of [panel, floatingDock]) {
    assert.doesNotMatch(detail, /actions\?\.approval/);
  }
});
