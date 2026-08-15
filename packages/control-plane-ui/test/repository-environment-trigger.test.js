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

  assert.match(environment, /triggerAppearance\?: "toolbar" \| "detail" \| "menu"/);
  assert.match(environment, /<PopoverTrigger as-child>\s*<button[\s\S]*?<TooltipTrigger as-child>\s*<span class="repository-environment-trigger-content">/);
  assert.doesNotMatch(environment, /<TooltipTrigger as-child>\s*<PopoverTrigger as-child>/);
  assert.match(environment, /\.repository-environment-trigger-detail \{[^}]*width: 26px;[^}]*height: 26px;[^}]*border-radius: 6px;[^}]*background: var\(--surface-subtle\)/);
  assert.match(environment, /\.repository-environment-trigger-menu \{[^}]*width: 100%;[^}]*align-items: center;[^}]*justify-content: flex-start;[^}]*gap: 8px;[^}]*color: var\(--text\);[^}]*font-family: inherit;[^}]*font-size: 14px;[^}]*line-height: 20px;/s);
  assert.match(environment, /\.repository-environment-trigger-menu span \{[^}]*font-size: inherit;/s);
  assert.match(environment, /\.repository-environment-trigger-menu:hover,[\s\S]*?background: var\(--accent\);[\s\S]*?color: var\(--accent-foreground\);/);
  assert.match(aiPanel, /<RepositoryEnvironment[\s\S]*?session-kind="ai-session"[\s\S]*?trigger-appearance="detail"/);
  assert.match(aiPanel, /<RepositoryEnvironment[\s\S]*?session-kind="ai-session"[\s\S]*?trigger-appearance="menu"/);

  const toolbarEnvironment = sessionPreview.match(/<RepositoryEnvironment[\s\S]*?\/>/)?.[0] || "";
  assert.match(toolbarEnvironment, /session-kind="app-session"/);
  assert.doesNotMatch(toolbarEnvironment, /trigger-appearance=/);
});
