const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const Fastify = require("fastify");
const {
  IMAGE_OMITTED_PLACEHOLDER,
  ImagePruningBodyError,
  pruneModelRelayImages,
} = require("../packages/control-plane/src/node-agent/models/relay/image-pruning.ts");
const { ModelRelayService } = require("../packages/control-plane/src/node-agent/models/relay/server.ts");

function chatImage(url, index) {
  return {
    type: "image_url",
    image_url: { url, detail: "high" },
    file_id: `file_${index}`,
    extension: { index },
  };
}

function responsesImage(url, index) {
  return {
    type: "input_image",
    image_url: url,
    file_id: `file_${index}`,
    detail: "original",
    extension: { index },
  };
}

function anthropicImage(data, index) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
    cache_control: { type: "ephemeral" },
    extension: { index },
  };
}

function chatPayload(imageCount = 10) {
  return {
    model: "public-image-pruning",
    messages: [
      { role: "system", content: "image_url in ordinary text is not an image part" },
      {
        role: "user",
        content: Array.from({ length: imageCount }, (_, index) => chatImage(`https://images.example/${index}.png`, index)),
      },
    ],
    tools: [{ type: "function", function: { parameters: { properties: { image_url: { type: "string" } } } } }],
    metadata: { image_url: "https://not-a-content-part.example/should-remain.png" },
  };
}

function responsesPayload(imageCount = 10) {
  return {
    model: "public-image-pruning",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "older images follow" },
        ...Array.from({ length: imageCount }, (_, index) => responsesImage(`https://responses.example/${index}.png`, index)),
      ],
    }],
    tools: [{ type: "function", name: "echo", parameters: { properties: { input_image: { type: "string" } } } }],
  };
}

function anthropicPayload(imageCount = 10) {
  return {
    model: "public-image-pruning",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "before" },
        ...Array.from({ length: imageCount }, (_, index) => anthropicImage(`data-${index}`, index)),
      ],
    }],
  };
}

function pruneWith(protocol, payload, keepLatestImages) {
  return pruneModelRelayImages(protocol, payload, keepLatestImages);
}

test("chat completions prunes only whitelisted content image parts and keeps the latest N unchanged", () => {
  const payload = chatPayload(10);
  const originalLatest = payload.messages[1].content[9];
  const result = pruneWith("openai-chat-completions", payload, 4);

  assert.equal(result.totalImages, 10);
  assert.equal(result.removedImages, 6);
  assert.equal(result.retainedImages, 4);
  assert.equal(result.changed, true);
  assert.deepEqual(payload.messages[1].content.map((part) => part.file_id), ["file_6", "file_7", "file_8", "file_9"]);
  assert.equal(payload.messages[1].content[3], originalLatest);
  assert.deepEqual(originalLatest, chatImage("https://images.example/9.png", 9));
  assert.deepEqual(payload.tools[0].function.parameters.properties.image_url, { type: "string" });
  assert.equal(payload.metadata.image_url, "https://not-a-content-part.example/should-remain.png");
  assert.equal(payload.messages[0].content, "image_url in ordinary text is not an image part");
});

test("responses and Anthropic traversal follow document order across nested content", () => {
  const responses = responsesPayload(5);
  const responseResult = pruneWith("openai-responses", responses, 2);
  assert.equal(responseResult.removedImages, 3);
  assert.deepEqual(responses.input[0].content.map((part) => part.type), ["input_text", "input_image", "input_image"]);
  assert.deepEqual(responses.input[0].content.slice(1).map((part) => part.file_id), ["file_3", "file_4"]);

  const anthropic = {
    messages: [{
      role: "user",
      content: [
        anthropicImage("old", 0),
        { type: "text", text: "between" },
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          is_error: true,
          content: [anthropicImage("tool-old", 1), { type: "text", text: "tool text" }, anthropicImage("tool-latest", 2)],
        },
        anthropicImage("latest", 3),
      ],
    }],
  };
  const anthropicResult = pruneWith("anthropic-messages", anthropic, 2);
  assert.equal(anthropicResult.totalImages, 4);
  assert.equal(anthropicResult.removedImages, 2);
  assert.deepEqual(anthropic.messages[0].content.map((part) => part.type), ["text", "tool_result", "image"]);
  const toolResult = anthropic.messages[0].content[1];
  assert.equal(toolResult.tool_use_id, "tool_1");
  assert.equal(toolResult.is_error, true);
  assert.deepEqual(toolResult.content.map((part) => part.type), ["text", "image"]);
  assert.equal(toolResult.content[1].source.data, "tool-latest");
  assert.equal(anthropic.messages[0].content[2].source.data, "latest");
});

test("empty content arrays receive protocol-specific text placeholders without dropping messages", () => {
  const chat = {
    messages: [
      { role: "assistant", content: [chatImage("https://images.example/old.png", 0)] },
      { role: "user", content: [chatImage("https://images.example/latest.png", 1)] },
    ],
  };
  assert.equal(pruneWith("openai-chat-completions", chat, 1).changed, true);
  assert.deepEqual(chat.messages[0].content, [{ type: "text", text: IMAGE_OMITTED_PLACEHOLDER }]);
  assert.equal(chat.messages[1].content[0].image_url.url, "https://images.example/latest.png");

  const responses = {
    input: [
      { role: "assistant", content: [responsesImage("https://images.example/old.png", 0)] },
      { role: "user", content: [responsesImage("https://images.example/latest.png", 1)] },
    ],
  };
  assert.equal(pruneWith("openai-responses", responses, 1).changed, true);
  assert.deepEqual(responses.input[0].content, [{ type: "input_text", text: IMAGE_OMITTED_PLACEHOLDER }]);
  assert.equal(responses.input[1].content[0].image_url, "https://images.example/latest.png");

  const anthropic = {
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_only", is_error: true, content: [anthropicImage("old", 0)] }],
      },
      { role: "user", content: [anthropicImage("latest", 1)] },
    ],
  };
  assert.equal(pruneWith("anthropic-messages", anthropic, 1).changed, true);
  assert.deepEqual(anthropic.messages[0].content[0], {
    type: "tool_result",
    tool_use_id: "tool_only",
    is_error: true,
    content: [{ type: "text", text: IMAGE_OMITTED_PLACEHOLDER }],
  });
  assert.equal(anthropic.messages[1].content[0].source.data, "latest");
});

test("requests at or below the image count keep their original image objects and no-op", () => {
  const payload = chatPayload(3);
  const before = structuredClone(payload);
  const result = pruneWith("openai-chat-completions", payload, 4);
  assert.equal(result.changed, false);
  assert.equal(result.removedImages, 0);
  assert.equal(result.retainedImages, 3);
  assert.deepEqual(payload, before);
});

test("malformed target containers fail closed instead of guessing", () => {
  assert.throws(() => pruneWith("openai-chat-completions", [], 1), ImagePruningBodyError);
  assert.throws(() => pruneWith("openai-chat-completions", { messages: {} }, 1), ImagePruningBodyError);
  assert.throws(() => pruneWith("openai-chat-completions", { messages: [{ content: {} }] }, 1), ImagePruningBodyError);
  assert.throws(() => pruneWith("openai-responses", { input: {} }, 1), ImagePruningBodyError);
});

function imagePruningConfig(overrides = {}) {
  return {
    enabled: true,
    triggerBodyBytes: 1,
    keepLatestImages: 1,
    maxInspectBytes: 1024 * 1024,
    onTooLarge: "reject",
    ...overrides,
  };
}

function relayInstance() {
  return {
    id: "inst_images",
    nodeId: "node_images",
    status: "running",
    registrationToken: "instance-image-token",
    capabilities: { features: { modelRelay: { protocols: ["openai-responses"], streaming: true } } },
  };
}

function relayModel() {
  return {
    id: "mdl_images_entity",
    name: "Image pruning model",
    endpoint: "http://upstream.test/v1",
    key: "upstream-image-secret",
    model: "public-image-pruning",
    modelNames: [{ name: "public-image-pruning", upstreamName: "upstream-image-pruning", order: 100 }],
    protocols: ["openai-responses"],
    app: "codex",
    enabled: true,
    order: 100,
    labels: {},
  };
}

async function readRequestBody(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createRelayHarness(t, options = {}) {
  const config = { current: options.config || imagePruningConfig() };
  const calls = [];
  const logs = [];
  const logger = {
    info: (data, message) => logs.push({ level: "info", data, message }),
    warn: (data, message) => logs.push({ level: "warn", data, message }),
    debug: (data, message) => logs.push({ level: "debug", data, message }),
  };
  const instance = relayInstance();
  const model = relayModel();
  const service = new ModelRelayService({
    resolver: {
      instance: () => instance,
      relayEnabled: () => true,
      resolveRoute: () => ({ instance, model, protocol: "openai-responses", routeId: "rly_images" }),
      resolveUpstreamModelName: () => "upstream-image-pruning",
    },
    imagePruning: () => config.current,
    limits: {
      maxConcurrentImagePruning: 1,
      imagePruningQueueTimeoutMs: 60,
      ...options.limits,
    },
    log: logger,
    fetchImpl: async (url, init) => {
      const body = await readRequestBody(init.body);
      calls.push({ url, init, body });
      return new Response(JSON.stringify({ data: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    adapters: [{
      protocol: "openai-responses",
      planOperation: ({ method, operationPath }) => {
        if (method === "POST" && operationPath === "/responses") {
          return { kind: "upstream", name: "responses.create", method: "POST", url: "http://upstream.test/v1/responses", responseMode: "raw" };
        }
        if (method === "POST" && operationPath === "/other") {
          return { kind: "upstream", name: "embeddings.create", method: "POST", url: "http://upstream.test/v1/other", responseMode: "raw" };
        }
        return { kind: "reject", name: "unknown", status: 404, code: "MODEL_RELAY_OPERATION_NOT_ALLOWED", message: "Operation not allowed." };
      },
      prepareRequest: async ({ body }) => ({ body }),
      prepareResponse: ({ body }) => body,
    }],
  });
  const app = Fastify({ logger: false });
  service.registerRoutes(app);
  await app.ready();
  t.after(async () => { await app.close(); });
  return {
    app,
    calls,
    logs,
    config,
    url: "/api/node-agent/model-relay/instances/inst_images/routes/rly_images/v1/responses",
    otherUrl: "/api/node-agent/model-relay/instances/inst_images/routes/rly_images/v1/other",
    headers: { authorization: "Bearer instance-image-token", "content-type": "application/json" },
  };
}

function injectRelay(app, url, headers, payload, extraHeaders = {}) {
  return app.inject({ method: "POST", url, headers: { ...headers, ...extraHeaders }, payload });
}

test("transport buffers over-threshold requests, prunes older images, and logs only safe counts", async (t) => {
  const harness = await createRelayHarness(t);
  const raw = JSON.stringify({
    model: "public-image-pruning",
    input: [{
      role: "user",
      content: [
        { type: "input_image", image_url: "https://private.example/old-secret.png" },
        { type: "input_text", text: "PROMPT_SECRET_MARKER" },
        { type: "input_image", image_url: "https://private.example/latest.png", file_id: "file_latest", detail: "high" },
      ],
    }],
  });
  harness.config.current = imagePruningConfig({ triggerBodyBytes: Buffer.byteLength(raw) - 1, keepLatestImages: 1 });

  const response = await injectRelay(harness.app, harness.url, harness.headers, raw);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(harness.calls.length, 1);
  const upstream = JSON.parse(harness.calls[0].body.toString("utf8"));
  assert.deepEqual(upstream.input[0].content, [
    { type: "input_text", text: "PROMPT_SECRET_MARKER" },
    { type: "input_image", image_url: "https://private.example/latest.png", file_id: "file_latest", detail: "high" },
  ]);

  const completed = harness.logs.find((entry) => entry.message === "model relay request completed");
  assert.ok(completed);
  assert.equal(completed.data.imagePruningOutcome, "applied");
  assert.equal(completed.data.removedImages, 1);
  assert.equal(completed.data.retainedImages, 1);
  assert.ok(Number.isFinite(completed.data.sourceRequestBytes));
  assert.ok(Number.isFinite(completed.data.imagePruningMs));
  const serializedLogs = JSON.stringify(harness.logs);
  for (const secret of ["private.example", "PROMPT_SECRET_MARKER", "file_latest", "upstream-image-secret", "instance-image-token"]) {
    assert.equal(serializedLogs.includes(secret), false, `${secret} must not be logged`);
  }
});

test("a request exactly at the trigger size keeps the original bytes and does not inspect images", async (t) => {
  const harness = await createRelayHarness(t);
  const raw = JSON.stringify(chatPayload(3), null, 2);
  harness.config.current = imagePruningConfig({ triggerBodyBytes: Buffer.byteLength(raw), keepLatestImages: 1 });

  const response = await injectRelay(harness.app, harness.url, harness.headers, raw);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0].body, Buffer.from(raw, "utf8"));
  assert.equal(JSON.parse(harness.calls[0].body.toString("utf8")).messages[1].content.length, 3);
  const completed = harness.logs.find((entry) => entry.message === "model relay request completed");
  assert.equal(completed.data.imagePruningOutcome, "below-threshold");
});

test("an over-threshold request with no images to remove uses the original body bytes", async (t) => {
  const harness = await createRelayHarness(t);
  const raw = JSON.stringify(responsesPayload(3), null, 2);
  harness.config.current = imagePruningConfig({ triggerBodyBytes: Buffer.byteLength(raw) - 1, keepLatestImages: 4 });

  const response = await injectRelay(harness.app, harness.url, harness.headers, raw);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0].body, Buffer.from(raw, "utf8"));
  const completed = harness.logs.find((entry) => entry.message === "model relay request completed");
  assert.equal(completed.data.imagePruningOutcome, "unchanged");
  assert.equal(completed.data.removedImages, 0);
  assert.equal(completed.data.retainedImages, 3);
});

test("non-JSON and non-target operations skip image inspection even above the trigger", async (t) => {
  const harness = await createRelayHarness(t);
  const invalidJson = `{"padding":"${"x".repeat(80)}"`;
  harness.config.current = imagePruningConfig({ triggerBodyBytes: 1 });

  const nonJson = await injectRelay(harness.app, harness.url, harness.headers, invalidJson, { "content-type": "text/plain" });
  assert.equal(nonJson.statusCode, 200, nonJson.body);
  assert.deepEqual(harness.calls[0].body, Buffer.from(invalidJson, "utf8"));

  const nonTarget = await injectRelay(harness.app, harness.otherUrl, harness.headers, invalidJson);
  assert.equal(nonTarget.statusCode, 200, nonTarget.body);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.calls[1].body, Buffer.from(invalidJson, "utf8"));
});

test("disabling image pruning immediately restores byte-for-byte pass-through", async (t) => {
  const harness = await createRelayHarness(t);
  const invalidJson = `{"padding":"${"x".repeat(80)}"`;
  harness.config.current = imagePruningConfig({ enabled: false, triggerBodyBytes: 1 });

  const response = await injectRelay(harness.app, harness.url, harness.headers, invalidJson);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0].body, Buffer.from(invalidJson, "utf8"));
  const completed = harness.logs.find((entry) => entry.message === "model relay request completed");
  assert.equal(completed.data.imagePruningOutcome, undefined);
});

test("chunked requests without Content-Length pass through without full-body inspection", async (t) => {
  const harness = await createRelayHarness(t);
  const raw = JSON.stringify(chatPayload(5));
  harness.config.current = imagePruningConfig({ triggerBodyBytes: 1, keepLatestImages: 1 });
  const origin = await harness.app.listen({ host: "127.0.0.1", port: 0 });

  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}${harness.url}`, {
      method: "POST",
      headers: { authorization: "Bearer instance-image-token", "content-type": "application/json" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.write(raw.slice(0, Math.floor(raw.length / 2)));
    setTimeout(() => request.end(raw.slice(Math.floor(raw.length / 2))), 20);
  });

  assert.equal(status, 200);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0].body, Buffer.from(raw, "utf8"));
  assert.equal(JSON.parse(harness.calls[0].body.toString("utf8")).messages[1].content.length, 5);
});

test("Content-Encoding and oversized inspect bodies follow pass-through or reject before upstream", async (t) => {
  const harness = await createRelayHarness(t);
  const raw = JSON.stringify(chatPayload(2));
  harness.config.current = imagePruningConfig({ triggerBodyBytes: 1, keepLatestImages: 1 });

  const compressed = await injectRelay(harness.app, harness.url, harness.headers, raw, { "content-encoding": "gzip" });
  assert.equal(compressed.statusCode, 200, compressed.body);
  assert.deepEqual(harness.calls[0].body, Buffer.from(raw, "utf8"));
  assert.equal(JSON.parse(harness.calls[0].body.toString("utf8")).messages[1].content.length, 2);

  harness.config.current = imagePruningConfig({
    triggerBodyBytes: 1,
    keepLatestImages: 1,
    maxInspectBytes: Buffer.byteLength(raw) - 1,
    onTooLarge: "reject",
  });
  const rejected = await injectRelay(harness.app, harness.url, harness.headers, raw);
  assert.equal(rejected.statusCode, 413, rejected.body);
  assert.equal(rejected.json().code, "MODEL_RELAY_IMAGE_PRUNING_BODY_TOO_LARGE");
  assert.equal(harness.calls.length, 1);

  harness.config.current = imagePruningConfig({
    triggerBodyBytes: 1,
    keepLatestImages: 1,
    maxInspectBytes: Buffer.byteLength(raw) - 1,
    onTooLarge: "passthrough",
  });
  const passed = await injectRelay(harness.app, harness.url, harness.headers, raw);
  assert.equal(passed.statusCode, 200, passed.body);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.calls[1].body, Buffer.from(raw, "utf8"));
});

test("invalid JSON and malformed containers fail before contacting the upstream", async (t) => {
  const harness = await createRelayHarness(t);
  harness.config.current = imagePruningConfig({ triggerBodyBytes: 1 });

  const invalidJson = `{"model":"public-image-pruning","input":"${"x".repeat(40)}"`;
  const invalid = await injectRelay(harness.app, harness.url, harness.headers, invalidJson);
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json().code, "MODEL_RELAY_IMAGE_PRUNING_INVALID_BODY");
  assert.equal(harness.calls.length, 0);

  const malformed = await injectRelay(harness.app, harness.url, harness.headers, JSON.stringify({ input: { content: [] }, padding: "x".repeat(40) }));
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(malformed.json().code, "MODEL_RELAY_IMAGE_PRUNING_INVALID_BODY");
  assert.equal(harness.calls.length, 0);
});

test("the image-pruning gate rejects queued work with a retryable busy error", async (t) => {
  const harness = await createRelayHarness(t, { limits: { imagePruningQueueTimeoutMs: 40 } });
  const raw = JSON.stringify(chatPayload(2));
  harness.config.current = imagePruningConfig({ triggerBodyBytes: 1 });
  const origin = await harness.app.listen({ host: "127.0.0.1", port: 0 });

  let firstRequest;
  const firstResponse = new Promise((resolve, reject) => {
    firstRequest = http.request(`${origin}${harness.url}`, {
      method: "POST",
      headers: {
        authorization: "Bearer instance-image-token",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(raw)),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    firstRequest.once("error", reject);
  });
  firstRequest.write(raw.slice(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 25));

  const busy = await injectRelay(harness.app, harness.url, harness.headers, raw);

  firstRequest.end(raw.slice(20));
  assert.equal(await firstResponse, 200);

  assert.equal(busy.statusCode, 503, busy.body);
  assert.equal(busy.json().code, "MODEL_RELAY_BUSY");
  assert.equal(harness.calls.length, 1);
});

test("image pruning source has no decoder, resizer, encoder, or remote-URL fetch dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "../packages/control-plane/src/node-agent/models/relay/image-pruning.ts"), "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:sharp|jimp|image-size|canvas)|require\(["'](?:sharp|jimp|image-size|canvas)/i);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?\.request|node:https/);
});
