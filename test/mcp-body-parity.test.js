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

test("MCP body parsing matches shared Node/Rust transport fixtures", async () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures/mcp-body-parity.json"), "utf8"));
  const app = require("fastify")();
  // Match the instance's global streaming parser, not Fastify's buffer parser.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  new StoryAgentToolBridge({ service: {}, resolveSession: () => undefined, endpoint: "http://test.invalid", token: "fixture-token" }).register(app);
  try {
    for (const fixture of fixtures) {
      const payload = fixture.hex ? Buffer.from(fixture.hex, "hex") : (fixture.prefix || "") + fixture.unit.repeat(fixture.repeat);
      const headers = { accept: "application/json, text/event-stream", "content-length": fixture.declaredLength ?? Buffer.byteLength(payload) };
      if (fixture.type !== null) headers["content-type"] = fixture.type;
      if (fixture.auth) headers.authorization = "Bearer fixture-token";
      const response = await app.inject({ method: fixture.method, url: "/api/internal/agent-tools/mcp", headers, payload });
      const actual = { status: response.statusCode };
      if (response.headers["content-type"]?.startsWith("text/event-stream")) {
        actual.events = response.body.split("\n\n").filter(Boolean).map(event => JSON.parse(event.slice("event: message\ndata: ".length)));
      } else actual.body = response.body ? response.json() : null;
      assert.deepEqual(actual, fixture.expected, fixture.name);
    }
  } finally {
    await app.close();
  }
});
