const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};

const { StoryAgentToolBridge } = require("../packages/controlled-instance/src/web/story-agent-tool-bridge.ts");

function fixturePayload(body) {
  if (body.text !== undefined) return Buffer.from(body.text);
  if (body.base64 !== undefined) return Buffer.from(body.base64, "base64");
  return Buffer.from(body.repeat.unit.repeat(body.repeat.count));
}

test("agent tool invocation matches shared Node/Rust auth and body fixtures", async () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures/agent-tool-invoke-parity.json"), "utf8"));
  const app = require("fastify")();
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  new StoryAgentToolBridge({
    token: "fixture-token",
    endpoint: "http://test.invalid",
    service: { invoke: async () => ({ ok: true }), invokeAgentRun: async () => ({ ok: true }) },
    resolveSession: (provider, providerSessionId) => providerSessionId === "fixture-session"
      ? { id: "session", agent: provider, storyId: "story" }
      : undefined,
  }).register(app);
  try {
    for (const fixture of fixtures) {
      const payload = fixturePayload(fixture.body);
      const headers = { "content-length": String(payload.byteLength) };
      if (fixture.type !== null) headers["content-type"] = fixture.type;
      if (fixture.auth) headers.authorization = "Bearer fixture-token";
      const response = await app.inject({ method: "POST", url: "/api/internal/agent-tools/invoke", headers, payload });
      assert.deepEqual({ status: response.statusCode, body: response.body ? response.json() : null }, fixture.expected, fixture.name);
    }
  } finally {
    await app.close();
  }
});
