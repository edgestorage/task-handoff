import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("AI session UI uses authoritative Direct create, Open App, and close actions", async () => {
  const [panel, board, store, cardMenu, queries, en, zh] = await Promise.all([
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("apps/control-plane/ai-board/AiSessionBoardView.vue"),
    source("apps/control-plane/useAiSessionStore.ts"),
    source("components/ai-session/AiSessionCardContextMenu.vue"),
    source("api/queries.ts"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  const createNewSession = panel.slice(
    panel.indexOf("async function createNewSession"),
    panel.indexOf("function canInterrupt"),
  );
  assert.match(panel, /createAiSession\(props\.instance\.id/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, result\.aiSessionId\)/);
  assert.doesNotMatch(createNewSession, /refreshBoard\(\)/);
  assert.doesNotMatch(createNewSession, /setTimeout\(resolve, 500\)/);
  assert.match(store, /return aiSessionSnapshotWithSummary\(snapshot, instance\.aiSessions\)/);
  assert.doesNotMatch(store, /hasBoundVisibleAppSession/);
  assert.doesNotMatch(panel, /async function createNewSession[\s\S]{0,1600}launchAppSession/);
  assert.match(panel, /openAiSessionApp\(props\.instance\.id, session\.id/);
  assert.match(panel, /closeAiSession\(props\.instance\.id, session\.id/);
  assert.match(panel, /session\.actions\?\.openApp/);
  assert.match(board, /openAiSessionApp\(instance\.id, session\.id/);
  assert.match(board, /closeAiSession\(card\.instance\.id, card\.session\.id/);
  assert.match(cardMenu, /\$emit\('closeSession'\)/);
  assert.match(queries, /ai-sessions\/\$\{encodeURIComponent\(aiSessionId\)\}\/open-app/);
  assert.match(queries, /ai-sessions\/\$\{encodeURIComponent\(aiSessionId\)\}\/close/);
  for (const locale of [en, zh]) {
    assert.match(locale, /closeSession:/);
    assert.match(locale, /openApp:/);
  }
});

test("history resume waits for source and provider identity without requiring an App binding", async () => {
  const panel = await source("apps/control-plane/instance-detail/AiSessionPanel.vue");
  assert.match(panel, /session\.creationSource === result\.creationSource/);
  assert.match(panel, /session\.providerSessionId === result\.providerSessionId/);
  assert.match(panel, /result\.appSessionId \? session\.appSessionId === result\.appSessionId : !session\.appSessionId/);
});
