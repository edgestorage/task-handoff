import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const activity = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const types = fs.readFileSync(new URL("../src/api/types.ts", import.meta.url), "utf8");

test("tool activity uses the authoritative API projection", () => {
  assert.match(types, /export type AiSessionTool = \{[\s\S]*?id\?: string;[\s\S]*?kind\?: string;[\s\S]*?name: string;/);
  assert.match(types, /currentTool\?: AiSessionTool;\s*toolCallsSinceLastMessage: number;/);
  assert.match(activity, /props\.toolCallsSinceLastMessage/);
  assert.match(activity, /props\.currentTool\?\.name/);
  assert.doesNotMatch(activity, /ref\(|watch\(/);
});

test("tool activity distinguishes current and completed-only windows", () => {
  assert.match(activity, /`Current Tool · \$\{count\.value\}`/);
  assert.match(activity, /`Tools executed · \$\{count\.value\}`/);
  assert.match(activity, /v-if="currentTool\?\.name"/);
  assert.match(activity, /v-if="currentTool\?\.inputPreview"/);
});

test("tool activity hides an empty window", () => {
  assert.match(activity, /const visible = computed\(\(\) => Boolean\(props\.currentTool\?\.name\) \|\| count\.value > 0\)/);
  assert.match(activity, /<section[\s\S]*?v-if="visible"/);
});

test("both detail surfaces share tool activity while cards remain unchanged", () => {
  assert.match(panel, /<AiSessionToolActivity[\s\S]*?:current-tool="selectedSession\.currentTool"[\s\S]*?:tool-calls-since-last-message="selectedSession\.toolCallsSinceLastMessage"/);
  assert.match(floatingDock, /<AiSessionToolActivity[\s\S]*?:current-tool="card\.session\.currentTool"[\s\S]*?:tool-calls-since-last-message="card\.session\.toolCallsSinceLastMessage"[\s\S]*?tone="board"/);
  assert.doesNotMatch(panel, /session-ai-card[\s\S]{0,180}toolCallsSinceLastMessage/);
});
