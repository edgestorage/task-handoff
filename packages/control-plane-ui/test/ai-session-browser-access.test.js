import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const browser = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/EmbeddedBrowserTab.vue", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../src/api/browserControl.ts", import.meta.url), "utf8");
const zh = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/sessions.ts", import.meta.url), "utf8");
const en = fs.readFileSync(new URL("../src/i18n/locales/en-US/sessions.ts", import.meta.url), "utf8");

test("Agent browser access belongs to the controlled instance, not an AI Session menu", () => {
  assert.doesNotMatch(panel, /grantBrowserControlAccess|revokeBrowserControlAccess|getBrowserControlAccess/);
  assert.doesNotMatch(panel, /agentAccessGrant|agentAccessRevoke/);
  assert.match(api, /controlled-instances\/\$\{encodeURIComponent\(instanceId\)\}\/browser-control\$\{suffix\}/);
  assert.match(api, /grantBrowserControlAccess\(\s*instanceId: string,/);
  assert.match(api, /getBrowserControlAccess\(instanceId: string\)/);
  assert.match(api, /revokeBrowserControlAccess\(instanceId: string\)/);
});

test("the embedded browser grants and revokes access for the whole instance", () => {
  assert.match(browser, /getBrowserControlAccess\(props\.instanceId\)/);
  assert.match(browser, /grantBrowserControlAccess\(props\.instanceId\)/);
  assert.match(browser, /revokeBrowserControlAccess\(props\.instanceId\)/);
  assert.match(browser, /browserControlAccess = ref<EmbeddedBrowserAccessView>\(\{ active: false, revision: 0 \}\)/);
  assert.match(browser, /await Promise\.all\(\[refreshBrowserControlAccess\(\), refreshBrowserCreationContext\(\)\]\)/);
  assert.match(browser, /<Popover :open="agentAccessOpen" @update:open="handleAgentAccessOpenChange">\s*<PopoverTrigger as-child>/);
  assert.match(browser, /class="embedded-browser-agent-access"/);
});

test("instance browser access copy explains the shared session scope and revocation", () => {
  for (const source of [zh, en]) {
    assert.match(source, /agentAccessGrant/);
    assert.match(source, /agentAccessRevoke/);
    assert.match(source, /agentAccessRevokeHint/);
  }
  assert.match(zh, /所有 AI 会话/);
  assert.match(en, /every AI Session/);
  assert.match(browser, /\.embedded-browser-agent-access-summary p\b[^{]*\{[^}]*font-size: 12px;/);
});
