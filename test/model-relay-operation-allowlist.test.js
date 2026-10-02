const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixturesDir = path.join(__dirname, "fixtures/model-relay");
const captures = ["codex-0.153.4-capture.json", "claude-code-2.1.286-capture.json", "opencode-1.18.29-capture.json"]
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8")));

// First-phase relay allowlist (design decision 5). The relay only forwards the
// operations declared here; it never acts as a general reverse proxy.
const ALLOWLIST = {
  "openai-responses": [["POST", "/responses"]],
  "openai-chat-completions": [["POST", "/chat/completions"]],
  "anthropic-messages": [["POST", "/messages"], ["POST", "/messages/count_tokens"]],
};
// Model catalog requests are synthesized by the relay from the authoritative
// assignment; they are never proxied to the upstream.
const SYNTHESIZED = [["GET", "/models"]];
// Claude Code probes its gateway before the first model call. The probe is not
// a model operation: it must be answered without upstream contact, and the
// client tolerates rejection.
const NON_MODEL_PROBES = [["HEAD", "/api/hello"]];

function normalizeOperationPath(rawPath) {
  const withoutQuery = rawPath.split("?")[0];
  return withoutQuery.startsWith("/v1") ? withoutQuery.slice("/v1".length) : withoutQuery;
}

function operationTable() {
  const table = new Set();
  for (const entries of [...Object.values(ALLOWLIST), SYNTHESIZED]) {
    for (const [method, operationPath] of entries) table.add(`${method} ${operationPath}`);
  }
  return table;
}

test("captured artifact operations are covered by the declared relay allowlist", () => {
  const allowed = operationTable();
  for (const capture of captures) {
    for (const operation of capture.operations) {
      const key = `${operation.method} ${normalizeOperationPath(operation.path)}`;
      if (NON_MODEL_PROBES.some(([method, probePath]) => `${method} ${probePath}` === key)) continue;
      assert.equal(allowed.has(key), true, `${capture.artifact.app} ${key} is missing from the relay allowlist`);
    }
  }
});

test("the Claude Code gateway probe never enters the relay allowlist", () => {
  const allowed = operationTable();
  assert.equal(allowed.has("HEAD /api/hello"), false);
  const probe = captures.find((capture) => capture.artifact.app === "claude").operations
    .find((operation) => operation.method === "HEAD");
  assert.equal(probe.path, "/api/hello");
  assert.match(probe.observed, /continues with the model request/);
});

test("captured artifacts confirm streaming request semantics and no upstream model discovery", () => {
  for (const capture of captures) {
    const modelOperations = capture.operations.filter((operation) => operation.method === "POST");
    assert.ok(modelOperations.length >= 1, `${capture.artifact.app} must capture at least one model request`);
    for (const operation of modelOperations) {
      assert.equal(operation.body.stream, true, `${capture.artifact.app} ${operation.path} must stream`);
    }
    assert.deepEqual(capture.modelsRequests, []);
  }
});

test("captured cancellation closes the downstream request while the upstream stream is open", () => {
  const codex = captures.find((capture) => capture.artifact.app === "codex");
  assert.equal(codex.cancel.observed, "response-closed-before-end");
  for (const capture of captures) {
    assert.ok(capture.cancel.scenario, `${capture.artifact.app} must record its cancellation expectation`);
  }
});
