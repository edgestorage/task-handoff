const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { INSTANCE_PRIVATE_CONFIG_FILE_NAME, InstancePrivateConfigStore } = require("../packages/node-agent/src/instances/private-config-store.ts");
const {
  readControlledPrivateAiSessionNextInputSuggestionEnabled,
  readControlledPrivateAiSessionNextInputSuggestionReasoningEffort,
} = require("../packages/controlled-instance/src/web/private-model-catalog.ts");

function storeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-next-input-private-"));
  const dir = path.join(root, "private");
  return { root, dir, store: new InstancePrivateConfigStore({ instancePrivateConfigsDir: dir }) };
}

test("private config materializes the suggestion switch and defaults old records to off", () => {
  const { dir, store } = storeFixture();
  const enabled = store.materialize("inst_one", "credential", {}, undefined, undefined, true);
  assert.equal(enabled.aiSessionNextInputSuggestionEnabled, true);
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionEnabled, true);

  const disabled = store.materialize("inst_one", "credential", {}, undefined, undefined, false);
  assert.equal(disabled.aiSessionNextInputSuggestionEnabled, false);
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionEnabled, false);

  const filePath = path.join(dir, "inst_one", INSTANCE_PRIVATE_CONFIG_FILE_NAME);
  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete legacy.aiSessionNextInputSuggestionEnabled;
  fs.writeFileSync(filePath, JSON.stringify(legacy));
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionEnabled, false);
});

test("the controlled instance reads the switch from env or the private config file", () => {
  const { root, store } = storeFixture();
  store.materialize("inst_one", "credential", {}, undefined, undefined, true);
  const configPath = store.filePath("inst_one");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({ TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: configPath }), true);
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED: "1",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), true);
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED: "true",
  }), true);
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED: "0",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), false);
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({ TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1" }), false);
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionEnabled({ TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: path.join(root, "missing.json") }), false);
});

test("private config persists the reasoning mode and defaults old records to none", () => {
  const { dir, store } = storeFixture();
  const configured = store.materialize("inst_one", "credential", {}, undefined, undefined, true, "session");
  assert.equal(configured.aiSessionNextInputSuggestionReasoningEffort, "session");
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionReasoningEffort, "session");

  const filePath = path.join(dir, "inst_one", INSTANCE_PRIVATE_CONFIG_FILE_NAME);
  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete legacy.aiSessionNextInputSuggestionReasoningEffort;
  fs.writeFileSync(filePath, JSON.stringify(legacy));
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionReasoningEffort, "none");

  const unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  unknown.aiSessionNextInputSuggestionReasoningEffort = "future";
  fs.writeFileSync(filePath, JSON.stringify(unknown));
  assert.equal(store.inspectMaterialized("inst_one").aiSessionNextInputSuggestionReasoningEffort, "none");
});

test("the controlled instance reads the reasoning mode from env or the private config file", () => {
  const { root, store } = storeFixture();
  store.materialize("inst_one", "credential", {}, undefined, undefined, true, "high");
  const configPath = store.filePath("inst_one");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionReasoningEffort({
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: configPath,
  }), "high");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionReasoningEffort({
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_REASONING_EFFORT: " SESSION ",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), "session");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionReasoningEffort({
    TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_REASONING_EFFORT: "future",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), "none");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionReasoningEffort({
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), "none");
  assert.equal(readControlledPrivateAiSessionNextInputSuggestionReasoningEffort({
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: path.join(root, "missing.json"),
  }), "none");
});

test("the Docker bootstrap projects the switch without adding a runtime env facade", () => {
  const { root, store } = storeFixture();
  const decode = (file) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "docker", "private-config.mjs"), file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return new Map(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [key, value] = line.split("\t");
      return [key, Buffer.from(value, "base64").toString("utf8")];
    }));
  };
  store.materialize("inst_on", "credential", {}, undefined, undefined, true);
  assert.equal(decode(store.filePath("inst_on")).get("TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED"), "1");
  store.materialize("inst_off", "credential", {}, undefined, undefined, false);
  assert.equal(decode(store.filePath("inst_off")).has("TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_ENABLED"), false);
  store.materialize("inst_mode", "credential", {}, undefined, undefined, true, "max");
  assert.equal(decode(store.filePath("inst_mode")).get("TASK_HANDOFF_PRIVATE_AI_SESSION_NEXT_INPUT_SUGGESTION_REASONING_EFFORT"), "max");
  fs.rmSync(root, { recursive: true, force: true });
});
