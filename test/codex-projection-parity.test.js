const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const test = require("node:test");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { codexToolDescriptor } = require("../packages/ai-session-runtime/src/codex-app-server/protocol/items.ts");
const { projectCodexTimelineItem, codexThreadTimeline } = require("../packages/ai-session-runtime/src/codex-app-server/protocol/timeline.ts");
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/ai-session/tests/fixtures/codex-projection-parity.json"), "utf8"));
const wire = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));

test("Codex items match the shared Node/Rust projection fixtures", () => {
  for (const fixture of fixtures.items) {
    assert.deepEqual(wire(projectCodexTimelineItem(fixture.item.id, "t1", fixture.item)), fixture.expectedTimeline, fixture.name);
    assert.deepEqual(wire(codexToolDescriptor(fixture.item)), fixture.expectedTool, fixture.name);
  }
});

test("Codex thread history matches the shared Node/Rust projection fixtures", () => {
  for (const fixture of fixtures.threadCases) {
    assert.deepEqual(wire(codexThreadTimeline("s1", "p1", fixture.thread).items), fixture.expected, fixture.name);
  }
});
