import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceRoot = new URL("../src/apps/control-plane/instance-detail/", import.meta.url);

test("repository environment matches detail actions without changing the tab toolbar trigger", async () => {
  const [environment, aiPanel, sessionPreview] = await Promise.all([
    readFile(new URL("RepositoryEnvironment.vue", sourceRoot), "utf8"),
    readFile(new URL("AiSessionPanel.vue", sourceRoot), "utf8"),
    readFile(new URL("SessionPreview.vue", sourceRoot), "utf8"),
  ]);

  assert.match(environment, /triggerAppearance\?: "toolbar" \| "detail"/);
  assert.match(environment, /\.repository-environment-trigger-detail \{[^}]*width: 26px;[^}]*height: 26px;[^}]*border-radius: 6px;[^}]*background: var\(--surface-subtle\)/);
  assert.match(aiPanel, /<RepositoryEnvironment[\s\S]*?session-kind="ai-session"[\s\S]*?trigger-appearance="detail"/);

  const toolbarEnvironment = sessionPreview.match(/<RepositoryEnvironment[\s\S]*?\/>/)?.[0] || "";
  assert.match(toolbarEnvironment, /session-kind="app-session"/);
  assert.doesNotMatch(toolbarEnvironment, /trigger-appearance=/);
});
