import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const editor = read("src/apps/control-plane/agent/AgentEditor.vue");
const modelMenu = read("src/components/ai-session/AiSessionModelMenu.vue");
const zhAgents = read("src/i18n/locales/zh-CN/agents.ts");
const enAgents = read("src/i18n/locales/en-US/agents.ts");

test("agent editor selects the agent first and the model from the provider-grouped menu", () => {
  // Agent（Codex、Claude 等）才是运行程序；模型连接只作为模型菜单里的分组出现。
  assert.match(editor, /t\("agents\.editor\.agent"\)/);
  assert.match(editor, /aiSessionLaunchableAppsForInstance\(selectedInstance\.value, t\)/);
  assert.match(editor, /<AiSessionModelMenu\s/);
  assert.match(editor, /:model-groups="modelGroups"/);
  assert.match(editor, /:model-selection="draftModelSelection"/);
  assert.match(editor, /:reasoning-effort-enabled="reasoningEffortEnabled"/);
  assert.match(editor, /@select-model="selectModel"/);
  assert.match(editor, /@select-reasoning-effort="selectReasoningEffort"/);
  // 模型菜单与推理档位都由共用组件渲染，编辑器不再各自铺平模型列表。
  assert.doesNotMatch(editor, /v-for="\(option, index\) in modelOptions"/);
  assert.doesNotMatch(editor, /availableReasoningEfforts/);
  assert.match(modelMenu, /v-for="group in modelGroups"/);
});

test("both locales name the editor field Agent instead of Provider", () => {
  for (const [name, locale] of Object.entries({ "zh-CN": zhAgents, "en-US": enAgents })) {
    assert.match(locale, /agent: "Agent",/, `${name} must label the field Agent`);
    assert.match(locale, /runtime: "Agent (?:与模型|and model)"/, `${name} must drop the Provider section title`);
    assert.doesNotMatch(locale, /provider: "Provider"/, `${name} must not keep Provider as a field label`);
  }
});

test("the model trigger states the model connection together with the model name", () => {
  assert.match(editor, /const modelTriggerLabel = computed\(\(\) => currentModelOption\.value/);
  assert.match(editor, /\$\{currentModelOption\.value\.providerName\} · \$\{currentModelOption\.value\.modelName\}/);
  assert.match(editor, /agents\.editor\.modelEmpty/);
  // 已保存但不在目录里的模型仍然回显模型名，并按既有规则阻塞保存。
  assert.match(editor, /: draft\.value\.modelName \|\| t\("agents\.editor\.modelEmpty"\)/);
  assert.match(editor, /const storedModelUnavailable = computed/);
});
