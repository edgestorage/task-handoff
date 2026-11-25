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

const {
  aiSessionNextInputContext,
  isAiSessionNextInputEligible,
  parseAiSessionNextInputSuggestion,
} = require("../packages/ai-session-runtime/src/ai-session-next-input.ts");
const { AiSessionStatusSchema, projectAiSessionsSnapshotForConsumer, resolveAiSessionNextInputSuggestionReasoningEffort } = require("../packages/protocol/src/ai-sessions.ts");
const {
  readControlledPrivateAiSessionNextInputSuggestionEnabled,
  readControlledPrivateAiSessionNextInputSuggestionReasoningEffort,
} = require("../packages/controlled-instance/src/web/private-model-catalog.ts");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ai-session-next-input-parity.json"), "utf8"));
const session = (value) => AiSessionStatusSchema.parse({
  creationSource: "ai-session",
  phase: "unknown",
  counters: { toolCalls: 0, edits: 0, approvals: 0 },
  queue: { revision: 0, pendingCount: 0, items: [] },
  subAgents: [],
  toolCallsSinceLastMessage: 0,
  startedAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:01:00.000Z",
  ...value,
});

test("next-input parser normalization matches the shared fixture", () => {
  for (const entry of fixture.parser) {
    assert.equal(parseAiSessionNextInputSuggestion(entry.raw) ?? null, entry.expected, entry.raw);
  }
});

test("next-input bounded context matches the shared fixture", () => {
  for (const entry of fixture.context) {
    assert.deepEqual(
      aiSessionNextInputContext(session(entry.session), entry.maxBytes).map((turn) => turn.user),
      entry.expectedUsers,
      entry.name,
    );
  }
});

test("next-input eligibility matches the shared fixture", () => {
  for (const entry of fixture.eligibility) {
    assert.equal(isAiSessionNextInputEligible(session(entry.session)), entry.expected, entry.name);
  }
});

test("next-input reasoning mode resolution matches the shared fixture", () => {
  for (const entry of fixture.reasoningEffort) {
    assert.equal(
      resolveAiSessionNextInputSuggestionReasoningEffort(entry.mode, entry.sessionEffort ?? undefined) ?? null,
      entry.expected,
      JSON.stringify(entry),
    );
  }
});

test("consumer projection strips suggestions independently from subagent lineage", () => {
  const source = session({
    id: "ses_0000000000003",
    agent: "codex",
    status: "idle",
    lineage: { kind: "subagent", parentProviderSessionId: "thread-root" },
    nextInputSuggestion: { text: "继续。", turnId: "turn_1", generatedAt: "2026-11-25T00:00:30.000Z" },
    startedAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:01:00.000Z",
  });
  for (const entry of fixture.consumer) {
    const projected = projectAiSessionsSnapshotForConsumer(
      { runningCount: 0, waitingCount: 0, staleCount: 0, sessions: [source], updatedAt: "2026-11-25T00:01:00.000Z" },
      { subagents: entry.subagents, nextInputSuggestion: entry.nextInputSuggestion },
    ).sessions[0];
    assert.equal(Boolean(projected.nextInputSuggestion), entry.expectedSuggestion, JSON.stringify(entry));
    assert.equal(Boolean(projected.lineage), entry.expectedLineage, JSON.stringify(entry));
  }
});

test("private config convergence matches the shared fixture", () => {
  for (const entry of fixture.config) {
    assert.equal(
      readControlledPrivateAiSessionNextInputSuggestionEnabled(entry.env),
      entry.expected,
      JSON.stringify(entry.env),
    );
  }
});

test("private reasoning mode convergence matches the shared fixture", () => {
  for (const entry of fixture.reasoningEffortConfig) {
    assert.equal(
      readControlledPrivateAiSessionNextInputSuggestionReasoningEffort(entry.env),
      entry.expected,
      JSON.stringify(entry.env),
    );
  }
});
