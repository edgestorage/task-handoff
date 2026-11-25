import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AI session unread travels with the instance session stream and is cleared by the read action", () => {
  const events = read("apps/control-plane/useControlPlaneEvents.ts");
  const store = read("apps/control-plane/useAiSessionStore.ts");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const card = read("apps/control-plane/ai-board/AiSessionCard.vue");
  const sessions = read("apps/control-plane/instance-detail/useActiveInstanceSessions.ts");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const panelStyles = read("apps/control-plane/instance-detail/AiSessionPanel.css");
  const sharedState = fs.readFileSync(new URL("../../control-plane-client/src/ai-session-state.ts", import.meta.url), "utf8");
  const sharedSessions = fs.readFileSync(new URL("../../control-plane-client/src/ai-sessions.ts", import.meta.url), "utf8");

  assert.doesNotMatch(events, /AiSessionUnreadEventType|applyUnreadEvent/);
  assert.match(store, /applyControlPlaneAiSessionStreamEvent/);
  assert.doesNotMatch(store, /applyAiSessionUnreadState|deriveAiSessionUnread/);
  assert.doesNotMatch(sharedState, /deriveAiSessionUnreadAfterStreamEvent|applyAiSessionUnreadState/);
  assert.match(sharedSessions, /export const ControlPlaneAiSessionSummarySchema = AiSessionSummarySchema/);
  assert.match(sharedSessions, /markRead\(instanceId: string, sessionId: string\)/);
  assert.match(board, /selectedCard\.value\?\.session\.unread[\s\S]*markAiSessionRead\(card\.instance\.id, card\.session\.id\)/);
  assert.match(sessions, /session\?\.unread[\s\S]*markAiSessionRead\(instanceId, session\.id\)/);
  assert.match(panel, /watch\(\(\) => \(\{[\s\S]*selectedSession\.value\?\.unread[\s\S]*markAiSessionRead\(props\.instance\.id, current\.id\)/);
  assert.match(card, /:data-unread="card\.session\.unread \? 'true' : undefined"[\s\S]*?<span v-if="card\.session\.unread" class="ai-session-unread-dot"/);
  assert.match(panel, /:data-unread="session\.unread \? 'true' : undefined"[\s\S]*?<span v-if="session\.unread" class="ai-session-unread-dot"/);
  assert.match(card, /\.ai-session-unread-dot \{[\s\S]*?position: absolute;[\s\S]*?top: 13px;[\s\S]*?right: 32px;[\s\S]*?background: var\(--status-info\);/);
  assert.match(panelStyles, /\.ai-session-unread-dot \{[\s\S]*?position: absolute;[\s\S]*?top: 13px;[\s\S]*?right: 32px;[\s\S]*?background: var\(--status-info\);/);
  assert.doesNotMatch(card, /ai-board-card-tools/);
  assert.doesNotMatch(panel, /session-ai-card-tools/);
});

test("an AI session can be marked unread again without being cleared by its open detail view", () => {
  const menu = read("components/ai-session/AiSessionCardContextMenu.vue");
  const queries = read("api/queries.ts");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const card = read("apps/control-plane/ai-board/AiSessionCard.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const story = read("apps/control-plane/story/StoryView.vue");
  const sharedSessions = fs.readFileSync(new URL("../../control-plane-client/src/ai-sessions.ts", import.meta.url), "utf8");
  const en = read("i18n/locales/en-US/sessions.ts");
  const zh = read("i18n/locales/zh-CN/sessions.ts");

  assert.match(sharedSessions, /markUnread\(instanceId: string, sessionId: string\)[\s\S]*\/unread/);
  assert.match(queries, /sharedAiSessionsApi\.markUnread\(instanceId, sessionId\)/);
  assert.match(menu, /v-if="canMarkUnread && !isUnread"[\s\S]*@select="\$emit\('markUnread'\)"/);
  assert.match(menu, /sessions\.actions\.markUnread/);
  const storyMenuIndex = menu.indexOf('@update:open="onStoryMenuOpen"');
  const markUnreadIndex = menu.indexOf('v-if="canMarkUnread && !isUnread"');
  const openAppIndex = menu.indexOf('v-if="canOpenApp"');
  assert.ok(storyMenuIndex < markUnreadIndex && markUnreadIndex < openAppIndex);
  assert.match(story, /:is-unread="entry\.session\.unread"[\s\S]*@mark-unread="markSessionUnread\(entry\)"/);
  assert.match(card, /:is-unread="card\.session\.unread"[\s\S]*@mark-unread="\$emit\('markUnread', card\)"/);
  assert.match(panel, /:is-unread="session\.unread"[\s\S]*@mark-unread="markSessionUnread\(session\)"/);
  assert.match(board, /@mark-unread="markCardUnread"/);
  assert.match(board, /await markAiSessionUnread\(card\.instance\.id, card\.session\.id\)/);
  assert.match(panel, /await markAiSessionUnread\(props\.instance\.id, session\.id\)/);
  assert.match(board, /updatedAt: selectedCard\.value\?\.session\.updatedAt[\s\S]*newActivity = previous\?\.unread === false && current\.updatedAt !== previous\.updatedAt/);
  assert.match(panel, /updatedAt: selectedSession\.value\?\.updatedAt[\s\S]*newActivity = previous\?\.unread === false && current\.updatedAt !== previous\.updatedAt/);
  for (const locale of [en, zh]) {
    assert.match(locale, /markUnread:/);
    assert.match(locale, /markedUnread:/);
    assert.match(locale, /markUnreadFailed:/);
  }
});
