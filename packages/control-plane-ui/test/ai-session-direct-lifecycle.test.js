import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("AI session UI uses authoritative Direct create, Open App, and close actions", async () => {
  const [panel, board, store, instanceSessions, cardMenu, queries, sharedClient, en, zh] = await Promise.all([
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("apps/control-plane/ai-board/AiSessionBoardView.vue"),
    source("apps/control-plane/useAiSessionStore.ts"),
    source("apps/control-plane/useInstanceSessions.ts"),
    source("components/ai-session/AiSessionCardContextMenu.vue"),
    source("api/queries.ts"),
    readFile(new URL("../../control-plane-client/src/ai-sessions.ts", import.meta.url), "utf8"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  const createNewSession = panel.slice(
    panel.indexOf("async function createNewSession"),
    panel.indexOf("function canInterrupt"),
  );
  assert.match(panel, /createAiSession\(props\.instance\.id/);
  assert.match(createNewSession, /cwdFolderId = newSessionFolder\.value\?\.id/);
  assert.match(createNewSession, /\.\.\.\(cwdFolderId \? \{ cwdFolderId \} : \{\}\)/);
  assert.doesNotMatch(createNewSession, /runtime-path/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, result\.aiSessionId\)/);
  assert.doesNotMatch(createNewSession, /refreshBoard\(\)/);
  assert.doesNotMatch(createNewSession, /setTimeout\(resolve, 500\)/);
  assert.match(store, /return aiSessionSnapshotWithSummary\(snapshot, instance\.aiSessions\)/);
  assert.doesNotMatch(store, /hasBoundVisibleAppSession/);
  assert.doesNotMatch(panel, /async function createNewSession[\s\S]{0,1600}launchAppSession/);
  assert.match(panel, /openAiSessionApp\(props\.instance\.id, session\.id/);
  assert.match(panel, /emit\("openAiSessionApp", props\.instance, session\);\s*const result = await openAiSessionApp/);
  assert.match(panel, /emit\("openAiSessionApp", props\.instance, aiSessionAppNavigationTarget\(session, result\)\)/);
  assert.doesNotMatch(panel, /async function openSessionApp[\s\S]{0,1200}current\?\.appSessionId/);
  assert.match(panel, /closeAiSession\(props\.instance\.id, session\.id/);
  assert.match(panel, /session\.actions\?\.openApp/);
  assert.match(board, /openAiSessionApp\(instance\.id, session\.id/);
  assert.match(board, /emit\("openAiSessionApp", instance, session\);\s*const result = await openAiSessionApp/);
  assert.match(board, /emit\("openAiSessionApp", instance, aiSessionAppNavigationTarget\(session, result\)\)/);
  assert.doesNotMatch(board, /async function openCardApp[\s\S]{0,1200}current\?\.appSessionId/);
  assert.match(instanceSessions, /session\.providerSessionId \? \[`provider:\$\{session\.agent\}:\$\{session\.providerSessionId\}`\]/);
  assert.match(board, /closeAiSession\(card\.instance\.id, card\.session\.id/);
  assert.match(cardMenu, /\$emit\('closeSession'\)/);
  assert.match(queries, /sharedAiSessionsApi\.create\(instanceId, input\)/);
  assert.match(sharedClient, /const sessionRoute = .*ai-sessions/);
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

test("Fork creates an authoritative Direct AI session and waits for its projection", async () => {
  const [panel, board, card, cardMenu, queries, sharedClient] = await Promise.all([
    source("apps/control-plane/instance-detail/AiSessionPanel.vue"),
    source("apps/control-plane/ai-board/AiSessionBoardView.vue"),
    source("apps/control-plane/ai-board/AiSessionCard.vue"),
    source("components/ai-session/AiSessionCardContextMenu.vue"),
    source("api/queries.ts"),
    readFile(new URL("../../control-plane-client/src/ai-sessions.ts", import.meta.url), "utf8"),
  ]);

  for (const component of [panel, card]) {
    assert.match(component, /actions\?\.fork/);
    assert.match(component, /forkSession|forkCardSession/);
  }
  assert.match(cardMenu, /canFork/);
  assert.match(cardMenu, /\$emit\('forkSession', 'current'\)/);
  assert.match(cardMenu, /\$emit\('forkSession', 'managed-worktree'\)/);
  assert.match(panel, /turn\?\.status === "completed" && turn\.providerTurnId/);
  assert.match(panel, /forkSession\(selectedSession, 'current', selectedForkTurn\.id\)/);
  assert.match(queries, /sharedAiSessionsApi\.fork\(instanceId, aiSessionId, input\)/);
  assert.match(sharedClient, /requestData\([^\n]+AiSessionForkResultSchema/);
  for (const component of [panel, board]) {
    assert.match(component, /providerSessionId === result\.providerSessionId/);
    assert.match(component, /await new Promise\(\(resolve\) => setTimeout\(resolve, 100\)\)/);
    assert.match(component, /workspace: \{ mode \}/);
    assert.match(component, /requestKey = `[^`]+:\$\{mode\}(?::\$\{throughTurnId \|\| "latest"\})?`/);
  }
  assert.doesNotMatch(panel, /registry\.put|optimistic/i);
  assert.doesNotMatch(board, /registry\.put|optimistic/i);
});
