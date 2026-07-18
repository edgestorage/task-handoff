import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const component = fs.readFileSync(new URL("../src/components/ai-session/AiSessionSubAgents.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
const apiTypes = fs.readFileSync(new URL("../src/api/types.ts", import.meta.url), "utf8");

test("control-plane UI derives the sub-agent type from the protocol", () => {
  assert.match(apiTypes, /import type \{ AiSessionSubAgent as ProtocolAiSessionSubAgent \} from "@task-handoff\/protocol\/ai-sessions"/);
  assert.match(apiTypes, /export type AiSessionSubAgent = ProtocolAiSessionSubAgent/);
  assert.doesNotMatch(apiTypes, /status: "pending-init" \| "running"/);
});

test("AI session detail renders sub-agents after the main tool activity", () => {
  assert.match(panel, /<AiSessionResult/);
  assert.match(result, /<AiSessionToolActivity[\s\S]*?\/>\s*<AiSessionSubAgents/);
  assert.match(result, /v-if="session\.subAgents\?\.length"/);
  assert.match(result, /:sub-agents="session\.subAgents"/);
  assert.match(result, /<AiSessionSubAgents[\s\S]*?<section v-if="session\.queue\?\.items\.length"/);
});

test("sub-agent activity is independent from tool activity", () => {
  assert.match(component, /import type \{ AiSessionSubAgent \}/);
  assert.match(component, /Sub-agents · \$\{parts\.join\(" · "\)\}/);
  assert.match(component, /:key="agent\.threadId"/);
  assert.match(component, /agent\.path \|\| agent\.threadId/);
  assert.doesNotMatch(component, /Thinking/);
  assert.doesNotMatch(component, /toolCallsSinceLastMessage|currentTool/);
});

test("active and problem sub-agents expand while completed agents stay compact", () => {
  assert.match(component, /\["pending-init", "running", "interrupted", "errored"\]\.includes\(agent\.status\)/);
  assert.match(component, /const expanded = ref\(defaultExpanded\(props\.subAgents\)\)/);
  assert.match(component, /watch\(agentsRevision/);
  assert.match(component, /:aria-expanded="expanded"/);
  assert.match(component, /v-if="expanded" class="ai-session-sub-agents-list"/);
});

test("sub-agent rows expose lifecycle, latest activity, message, and update time", () => {
  assert.match(component, /:data-state="agent\.status"/);
  assert.match(component, /v-if="agent\.message"/);
  assert.match(component, /agent\.activity/);
  assert.match(component, /:datetime="agent\.updatedAt"/);
  assert.match(component, /data-state="running"/);
  assert.match(component, /data-state="completed"/);
  assert.match(component, /data-state="interrupted"/);
  assert.match(component, /data-state="errored"/);
});
