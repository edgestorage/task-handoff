const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
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

const { requestControlledAiSessionStructuredModel, requestControlledAiSessionTitle } = require("../packages/controlled-instance/src/web/session-title-model.ts");

const catalog = {
  protocolVersion: "2026-08-27",
  instanceId: "inst_one",
  entities: [{
    id: "provider_one",
    endpoint: "https://models.example/v1",
    key: "secret",
    protocols: ["openai-responses"],
    modelNames: [{ name: "model-one", order: 0 }],
  }],
  updatedAt: "2026-08-28T00:00:00.000Z",
};
const modelSelection = { modelEntityId: "provider_one", modelName: "model-one" };
const outputSchema = { type: "object", properties: { suggestion: { type: "string" } } };

function fetchReturning(text) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ output_text: text }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

test("the title request keeps its schema name and behavior", async () => {
  const fake = fetchReturning("标题");
  const text = await requestControlledAiSessionTitle({
    catalog,
    modelSelection,
    prompt: "给会话起标题",
    outputSchema,
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(text, "标题");
  assert.equal(fake.calls[0].body.text.format.name, "ai_session_title");
});

test("a structured suggestion request carries its own schema name and reuses route resolution", async () => {
  const fake = fetchReturning(JSON.stringify({ suggestion: "继续补齐测试" }));
  const text = await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    errorCodePrefix: "AI_SESSION_NEXT_INPUT_SUGGESTION",
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(text, JSON.stringify({ suggestion: "继续补齐测试" }));
  assert.equal(fake.calls[0].body.text.format.name, "ai_session_next_input_suggestion");
  assert.equal(fake.calls[0].body.model, "model-one");
  assert.equal(fake.calls[0].init.headers.authorization, "Bearer secret");
});

test("responses structured requests preserve system, user, and assistant roles", async () => {
  const fake = fetchReturning(JSON.stringify({ suggestion: "继续补齐测试" }));
  await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    messages: [
      { role: "system", content: "fixed system prompt" },
      { role: "user", content: "User: 修复登录\nAssistant: 已修复" },
      { role: "assistant", content: "继续补齐测试" },
      { role: "user", content: "User: 检查边界\nAssistant: 已检查" },
    ],
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(fake.calls[0].body.instructions, "fixed system prompt");
  assert.deepEqual(fake.calls[0].body.input, [
    { role: "user", content: [{ type: "input_text", text: "User: 修复登录\nAssistant: 已修复" }] },
    { role: "assistant", content: [{ type: "output_text", text: "继续补齐测试" }] },
    { role: "user", content: [{ type: "input_text", text: "User: 检查边界\nAssistant: 已检查" }] },
  ]);
  assert.equal("messages" in fake.calls[0].body, false);
});

test("chat-completions structured requests preserve the supplied message history", async () => {
  const chatCatalog = {
    ...catalog,
    entities: [{ ...catalog.entities[0], protocols: ["openai-chat-completions"] }],
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ suggestion: "继续补齐测试" }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await requestControlledAiSessionStructuredModel({
    catalog: chatCatalog,
    modelSelection,
    messages: [
      { role: "system", content: "fixed system prompt" },
      { role: "user", content: "User: 修复登录\nAssistant: 已修复" },
      { role: "assistant", content: "继续补齐测试" },
      { role: "user", content: "User: 检查边界\nAssistant: 已检查" },
    ],
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    fetchImpl,
  });
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.deepEqual(calls[0].body.messages, [
    { role: "system", content: "fixed system prompt" },
    { role: "user", content: "User: 修复登录\nAssistant: 已修复" },
    { role: "assistant", content: "继续补齐测试" },
    { role: "user", content: "User: 检查边界\nAssistant: 已检查" },
  ]);
  assert.equal("input" in calls[0].body, false);
});

test("an explicit none reasoning mode is sent as none instead of being omitted", async () => {
  const fake = fetchReturning(JSON.stringify({ suggestion: "继续补齐测试" }));
  await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    reasoningEffort: "none",
    prompt: "预测下一轮输入",
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    fetchImpl: fake.fetchImpl,
  });
  assert.deepEqual(fake.calls[0].body.reasoning, { effort: "none" });

  const explicit = fetchReturning(JSON.stringify({ suggestion: "继续补齐测试" }));
  await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    reasoningEffort: "high",
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: explicit.fetchImpl,
  });
  assert.deepEqual(explicit.calls[0].body.reasoning, { effort: "high" });

  const omitted = fetchReturning(JSON.stringify({ suggestion: "继续补齐测试" }));
  await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: omitted.fetchImpl,
  });
  assert.equal("reasoning" in omitted.calls[0].body, false);
});

test("structured responses accept compatible text parts and tool-call arguments", async () => {
  const suggestion = JSON.stringify({ suggestion: "继续补齐测试" });
  const chatCatalog = {
    ...catalog,
    entities: [{ ...catalog.entities[0], protocols: ["openai-chat-completions"] }],
  };
  const chat = await requestControlledAiSessionStructuredModel({
    catalog: chatCatalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ function: { arguments: suggestion } }] } }],
    }), { status: 200 }),
  });
  assert.equal(chat, suggestion);

  const responseToolCall = await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: async () => new Response(JSON.stringify({
      output: [{ type: "function_call", arguments: suggestion }],
    }), { status: 200 }),
  });
  assert.equal(responseToolCall, suggestion);

  const textPart = await requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: async () => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "text", text: suggestion }] }],
    }), { status: 200 }),
  });
  assert.equal(textPart, suggestion);
});

test("chat-completions structured requests pass an explicit none reasoning_effort", async () => {
  const chatCatalog = {
    ...catalog,
    entities: [{
      ...catalog.entities[0],
      protocols: ["openai-chat-completions"],
    }],
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ suggestion: "继续补齐测试" }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const text = await requestControlledAiSessionStructuredModel({
    catalog: chatCatalog,
    modelSelection,
    reasoningEffort: "none",
    prompt: "预测下一轮输入",
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    fetchImpl,
  });
  assert.equal(text, JSON.stringify({ suggestion: "继续补齐测试" }));
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].body.reasoning_effort, "none");
});

test("structured requests combine caller cancellation with the default timeout", async () => {
  const controller = new AbortController();
  const request = requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(request, /aborted/);

  await assert.rejects(requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    timeoutMs: 1,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    }),
  }), /timed out/);
});

test("structured requests fail with stable codes for every route and response boundary", async () => {
  const expectCode = async (promise, code) => {
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, code);
      return true;
    });
  };
  const base = {
    modelSelection,
    prompt: "预测下一轮输入",
    outputSchema,
    errorCodePrefix: "AI_SESSION_NEXT_INPUT_SUGGESTION",
  };

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog: undefined,
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_MODEL_UNAVAILABLE");

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog: { ...catalog, entities: [{ ...catalog.entities[0], protocols: ["anthropic-messages"] }] },
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_PROTOCOL_UNAVAILABLE");

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog: {
      protocolVersion: "2026-10-02",
      instanceId: "inst_one",
      entities: [{ id: "provider_one", protocols: ["openai-responses"], modelNames: [{ name: "model-one", order: 0 }], routes: [{ protocol: "openai-responses", baseUrl: "https://relay.example/v1" }] }],
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    env: {},
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_CREDENTIAL_UNAVAILABLE");

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog,
    fetchImpl: async () => new Response("upstream failed", { status: 502 }),
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_MODEL_REQUEST_FAILED");

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog,
    fetchImpl: async () => new Response("not json", { status: 200 }),
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_MODEL_RESPONSE_INVALID");

  await expectCode(requestControlledAiSessionStructuredModel({
    ...base,
    catalog,
    fetchImpl: async () => new Response(JSON.stringify({ output: [] }), { status: 200 }),
  }), "AI_SESSION_NEXT_INPUT_SUGGESTION_MODEL_RESPONSE_INVALID");
});

test("title and suggestion structured requests run in parallel without cancelling each other", async () => {
  const pending = new Map();
  const fetchImpl = (url, init) => new Promise((resolve) => {
    const body = JSON.parse(init.body);
    pending.set(body.text.format.name, () => resolve(new Response(JSON.stringify({
      output_text: body.text.format.name === "ai_session_title" ? "会话标题" : JSON.stringify({ suggestion: "下一句" }),
    }), { status: 200 })));
    void url;
  });
  const title = requestControlledAiSessionTitle({ catalog, modelSelection, prompt: "标题", outputSchema, fetchImpl });
  const suggestion = requestControlledAiSessionStructuredModel({
    catalog,
    modelSelection,
    prompt: "建议",
    outputSchema,
    schemaName: "ai_session_next_input_suggestion",
    fetchImpl,
  });
  await new Promise((resolve) => setImmediate(resolve));
  pending.get("ai_session_title")();
  pending.get("ai_session_next_input_suggestion")();
  assert.equal(await title, "会话标题");
  assert.equal(await suggestion, JSON.stringify({ suggestion: "下一句" }));
});
