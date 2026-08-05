import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AI session unread state is pushed once and cleared only by opening details", () => {
  const events = read("apps/control-plane/useControlPlaneEvents.ts");
  const store = read("apps/control-plane/useAiSessionStore.ts");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const card = read("apps/control-plane/ai-board/AiSessionCard.vue");
  const sessions = read("apps/control-plane/instance-detail/useActiveInstanceSessions.ts");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const sharedState = fs.readFileSync(new URL("../../control-plane-client/src/ai-session-state.ts", import.meta.url), "utf8");

  assert.match(events, /AiSessionUnreadEventType\.Updated/);
  assert.match(events, /applyUnreadEvent\(state\.data\)/);
  assert.match(store, /applyControlPlaneAiSessionStreamEvent/);
  assert.match(store, /applyAiSessionUnreadState/);
  assert.match(sharedState, /session\.status === "running" \|\| session\.status === "waiting" \? false/);
  assert.match(sharedState, /session\.updatedAt !== state\.sessionUpdatedAt/);
  assert.match(board, /selectedCard\.value\?\.session\.unread[\s\S]*markAiSessionRead/);
  assert.match(sessions, /function openAiSessionApp[\s\S]*markAiSessionRead/);
  assert.match(panel, /watch\(\(\) => \(\{[\s\S]*selectedSession\.value\?\.unread[\s\S]*markAiSessionRead/);
  assert.match(card, /card\.session\.unread[\s\S]*ai-session-unread-dot/);
  assert.match(panel, /session\.unread[\s\S]*ai-session-unread-dot/);
});
