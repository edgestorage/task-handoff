import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const composer = read("src/components/ai-session/AiSessionComposer.vue");
const panel = read("src/apps/control-plane/instance-detail/AiSessionPanel.vue");

test("an unsupported in-session switch keeps the current model instead of claiming no model", () => {
  assert.match(composer, /modelSelectionEnabled\?: boolean;/);
  assert.match(composer, /const modelSelectionLocked = computed\(\(\) => noModelAvailable\.value && props\.modelSelectionEnabled === false\)/);
  // 只读分支先于"没有模型"空状态，且仍然回显当前模型名。
  assert.match(composer, /<TooltipProvider v-if="modelSelectionLocked"[\s\S]*?sessions\.composer\.modelSelectionUnavailable[\s\S]*?<TooltipProvider v-else-if="noModelAvailable"/);
  assert.doesNotMatch(composer, /v-else-if="provider"/);
});

test("the session and history composers follow the provider's model-selection capability", () => {
  assert.match(panel, /import \{\s*aiSessionModelSelectionAllowed,\s*aiSessionPriority,/);
  assert.match(panel, /const selectedSessionModelSelectionEnabled = computed\(\(\) => aiSessionModelSelectionAllowed\(/);
  assert.match(panel, /const historyModelSelectionEnabled = computed\(\(\) => aiSessionModelSelectionAllowed\(/);
  assert.match(panel, /:model-selection-enabled="selectedSessionModelSelectionEnabled"/);
  assert.match(panel, /:model-selection-enabled="historyModelSelectionEnabled"/);
  // 只读回显要保留被恢复会话自身的模型，而不是被空目录清成占位文案。
  assert.match(panel, /const historyModelDisplay = computed\(\(\) => historyModelSelection\.value \|\| historyDetail\.value\?\.item\.modelSelection\)/);
  assert.match(panel, /:model-selection="historyModelDisplay"/);
});
