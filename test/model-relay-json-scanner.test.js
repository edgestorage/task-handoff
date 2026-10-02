const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  JsonModelScanner,
  decodeJsonString,
  rewriteJsonModelBuffer,
  rewriteJsonModelResponseBody,
  createModelRelayRequestBody,
} = require("../packages/control-plane/src/node-agent/models/relay/json-model-rewrite.ts");
const { rewriteSseModelResponseBody } = require("../packages/control-plane/src/node-agent/models/relay/sse-model-rewrite.ts");

function rewriteWithScanner(buffer, paths, replace) {
  const scanner = new JsonModelScanner({ paths, onModelValue: replace });
  const output = [...scanner.push(Buffer.from(buffer, "utf8")), ...scanner.end()];
  return { text: Buffer.concat(output).toString("utf8"), matched: scanner.matched };
}

function rewriteChunked(buffer, paths, replace, chunkSize) {
  const scanner = new JsonModelScanner({ paths, onModelValue: replace });
  const output = [];
  for (let index = 0; index < buffer.length; index += chunkSize) output.push(...scanner.push(buffer.subarray(index, index + chunkSize)));
  output.push(...scanner.end());
  return Buffer.concat(output);
}

function upstreamReplacement(external, upstream) {
  return (value) => (value === external ? Buffer.from(JSON.stringify(upstream), "utf8") : undefined);
}

test("the scanner rewrites only declared paths and keeps every other byte", () => {
  const input = '{"keep":"model","nested":{"model":"external"},"model":"external","list":[{"model":"external"}]}';
  const { text, matched } = rewriteWithScanner(input, [["model"]], upstreamReplacement("external", "upstream"));
  assert.equal(matched, true);
  assert.equal(text, '{"keep":"model","nested":{"model":"external"},"model":"upstream","list":[{"model":"external"}]}');
});

test("nested response paths rewrite message and response model fields only", () => {
  const { text } = rewriteWithScanner(
    '{"model":"upstream","message":{"model":"upstream","content":[{"type":"text","text":"upstream"}]}}',
    [["model"], ["message", "model"]],
    upstreamReplacement("upstream", "external"),
  );
  assert.equal(text, '{"model":"external","message":{"model":"external","content":[{"type":"text","text":"upstream"}]}}');
});

test("5 MB scalars, unicode and escaped strings survive byte-for-byte", () => {
  const payload = "P".repeat(5 * 1024 * 1024);
  const input = Buffer.from(JSON.stringify({ model: "upstream", note: "中文 \"quoted\" \\ 🚀", prompt: payload }), "utf8");
  const output = rewriteJsonModelBuffer(input, { paths: [["model"]], externalName: "外部", expectedUpstreamName: "upstream" });
  const expected = Buffer.from(JSON.stringify({ model: "外部", note: "中文 \"quoted\" \\ 🚀", prompt: payload }), "utf8");
  assert.equal(output.equals(expected), true);
});

test("7-byte chunk boundaries produce identical output to a single chunk", () => {
  const body = Buffer.from(JSON.stringify({ model: "external", input: "x".repeat(200_000), tail: "end" }), "utf8");
  const single = rewriteJsonModelBuffer(body, { paths: [["model"]], externalName: "external", expectedUpstreamName: "upstream" });
  const chunked = rewriteChunked(body, [["model"]], upstreamReplacement("external", "upstream"), 7);
  // The chunked scanner resolves external -> upstream, matching a request rewrite.
  const expected = Buffer.from(JSON.stringify({ model: "upstream", input: "x".repeat(200_000), tail: "end" }), "utf8");
  assert.equal(chunked.equals(expected), true);
  assert.notEqual(single.equals(expected), true);
});

test("model paths never leak into nested containers or array elements", async () => {
  const nested = rewriteWithScanner('{"model":[{"model":"external"}],"keep":"external"}', [["model"]], upstreamReplacement("external", "upstream"));
  assert.equal(nested.matched, false);
  assert.equal(nested.text, '{"model":[{"model":"external"}],"keep":"external"}');
  await assert.rejects(
    createModelRelayRequestBody({
      body: Readable.from([Buffer.from('{"model":["external"]}')]),
      resolveUpstreamModelName: () => "upstream",
      maxPrologueBytes: 64 * 1024,
    }),
    { code: "MODEL_RELAY_INVALID_REQUEST_MODEL" },
  );
});

test("decodeJsonString handles escapes and surrogate pairs", () => {
  assert.equal(decodeJsonString(Buffer.from('"plain"')), "plain");
  assert.equal(decodeJsonString(Buffer.from('"a\\nb\\u0041"')), "a\nbA");
  assert.equal(decodeJsonString(Buffer.from('"\\ud83d\\ude00"')), "😀");
  assert.equal(decodeJsonString(Buffer.from('"中文"')), "中文");
});

test("request resolution buffers a bounded prologue, then streams the remainder", async () => {
  const body = JSON.stringify({ model: "external", input: "x".repeat(1_000_000), tail: "end" });
  const prepared = await createModelRelayRequestBody({
    body: Readable.from([Buffer.from(body, "utf8")]),
    resolveUpstreamModelName: (name) => (name === "external" ? "upstream" : assert.fail("unknown")),
    maxPrologueBytes: 256 * 1024,
  });
  assert.equal(prepared.externalModelName, "external");
  assert.equal(prepared.upstreamModelName, "upstream");
  const chunks = [];
  for await (const chunk of prepared.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), body.replace('"external"', '"upstream"'));
});

test("request resolution fails closed for missing, invalid, oversized and duplicate model fields", async () => {
  const resolve = (name) => (name === "external" ? "upstream" : assert.fail("unknown model name must throw from the resolver"));
  const resolveUnknown = () => { throw Object.assign(new Error("unknown"), { statusCode: 400, code: "MODEL_RELAY_UNKNOWN_MODEL_NAME" }); };
  const prepare = async (json, options = {}) => createModelRelayRequestBody({
    body: Readable.from([Buffer.from(json, "utf8")]),
    resolveUpstreamModelName: options.resolve || resolve,
    maxPrologueBytes: options.maxPrologueBytes || 256 * 1024,
  });

  await assert.rejects(prepare('{"input":"x"}'), { code: "MODEL_RELAY_INVALID_REQUEST_MODEL" });
  await assert.rejects(prepare('{"model":123,"input":"x"}'), { code: "MODEL_RELAY_INVALID_REQUEST_MODEL" });
  await assert.rejects(prepare('{"model":"other","input":"x"}', { resolve: resolveUnknown }), { code: "MODEL_RELAY_UNKNOWN_MODEL_NAME" });
  await assert.rejects(prepare(JSON.stringify({ input: "x".repeat(300 * 1024), model: "external" })), {
    statusCode: 413,
    code: "MODEL_RELAY_REQUEST_PROLOGUE_TOO_LARGE",
  });
  // The duplicate field appears after the resolved model, so it is detected
  // while the body streams and must abort the request instead of forwarding.
  const duplicate = await prepare(`{"model":"external","input":"${"x".repeat(300 * 1024)}","model":"external"}`);
  await assert.rejects(async () => { for await (const _chunk of duplicate.body) undefined; }, { code: "MODEL_RELAY_AMBIGUOUS_MODEL_NAME" });
});

test("response rewriting keeps actual values on upstream mismatch and reports once", async () => {
  let mismatches = 0;
  const mapping = {
    paths: [["model"]],
    externalName: "external",
    expectedUpstreamName: "upstream",
    onMismatch: () => { mismatches += 1; },
  };
  assert.equal(rewriteJsonModelBuffer(Buffer.from('{"model":"other"}'), mapping).toString("utf8"), '{"model":"other"}');
  assert.equal(mismatches, 1);
  const streamed = [];
  for await (const chunk of rewriteJsonModelResponseBody(Readable.from([Buffer.from('{"model":"upstream"}')]), mapping)) streamed.push(chunk);
  assert.equal(Buffer.concat(streamed).toString("utf8"), '{"model":"external"}');
  assert.equal(mismatches, 1);
});

test("the SSE framer preserves non-data lines, multi-line data and [DONE]", async () => {
  const input = [
    ": keepalive\r\n",
    "id: 3\r\n",
    'event: message_start\r\n',
    'data: {"type":"message_start",\r\n',
    'data: "message":{"model":"upstream"}}\r\n',
    "\r\n",
    "data: [DONE]\n\n",
  ].join("");
  const output = [];
  const stream = rewriteSseModelResponseBody(
    Readable.from([Buffer.from(input, "utf8")]),
    { paths: [["model"], ["message", "model"]], externalName: "external", expectedUpstreamName: "upstream" },
    { maxEventBytes: 1024 * 1024 },
  );
  for await (const chunk of stream) output.push(chunk);
  const text = Buffer.concat(output).toString("utf8");
  assert.ok(text.includes(": keepalive\r\nid: 3\r\n"));
  // The event keeps its two `data:` lines: the SSE join separator is preserved
  // and the rewrite is mapped back onto the original framing.
  assert.ok(text.includes('event: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":{"model":"external"}}\r\n'));
  assert.ok(text.includes("data: [DONE]\n\n"));
  assert.equal(text.includes("upstream"), false);
});

test("the SSE framer never rewrites a model name that is split across data lines", async () => {
  const input = 'data: {"model":"up\ndata: stream"}\n\n';
  const output = [];
  const stream = rewriteSseModelResponseBody(
    Readable.from([Buffer.from(input, "utf8")]),
    { paths: [["model"]], externalName: "external", expectedUpstreamName: "upstream" },
    { maxEventBytes: 1024 * 1024 },
  );
  for await (const chunk of stream) output.push(chunk);
  // The joined payload is `up\nstream`, which is not the requested upstream
  // name, so the event must pass through byte-for-byte instead of being
  // concatenated into a bogus replacement.
  assert.equal(Buffer.concat(output).toString("utf8"), input);
});

test("the SSE framer rejects events above the configured frame limit", async () => {
  const stream = rewriteSseModelResponseBody(
    Readable.from([Buffer.from(`data: {"model":"upstream"}\n\n`, "utf8")]),
    { paths: [["model"]], externalName: "external", expectedUpstreamName: "upstream" },
    { maxEventBytes: 8 },
  );
  await assert.rejects(async () => { for await (const _chunk of stream) undefined; }, { code: "MODEL_RELAY_UPSTREAM_STREAM_ERROR" });
});
