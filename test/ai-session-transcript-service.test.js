const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  AiSessionTranscriptService,
} = require("../packages/ai-session-runtime/src/ai-session/transcript-service.ts");

test("transcript backfill preserves deterministic occurrence-based turn ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-transcript-service-"));
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: "user", message: { content: "repeat" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "exit 1" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "failed" }] } }),
    JSON.stringify({ type: "user", message: { content: "repeat" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
  ].join("\n"));
  const service = new AiSessionTranscriptService({ idleAfterMs: 1000, staleAfterMs: 60_000 });

  const first = service.backfill(transcriptPath);
  const second = service.backfill(transcriptPath);

  assert.equal(first.turns.length, 2);
  assert.notEqual(first.turns[0].id, first.turns[1].id);
  assert.deepEqual(first.turns.map((turn) => turn.id), second.turns.map((turn) => turn.id));
  assert.deepEqual(first.turns.map((turn) => turn.lastMessage), ["first", "second"]);
});

test("transcript line ingestion emits transcript-tail events with stable active turn ids", () => {
  const service = new AiSessionTranscriptService({ idleAfterMs: 1000, staleAfterMs: 60_000, now: () => Date.parse("2026-07-18T00:00:00.000Z") });
  const events = [];
  const registry = {
    get: () => undefined,
    applyRealtimeEvent: (_id, event) => {
      events.push(event);
      return undefined;
    },
  };
  const state = { calls: new Map(), promptCounts: new Map() };

  service.ingestLine(registry, "ais_test", JSON.stringify({ type: "user", message: { content: "repeat" } }), state);
  service.ingestLine(registry, "ais_test", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }), state);

  assert.equal(events[0].source, "transcript-tail");
  assert.equal(events[0].activeTurnId, events[0].providerTurnId);
  assert.equal(events[1].activeTurnId, events[0].activeTurnId);
  assert.equal(events[1].source, "transcript-tail");
});

test("transcript tool activity never becomes an assistant message", () => {
  const service = new AiSessionTranscriptService({ idleAfterMs: 1000, staleAfterMs: 60_000 });
  const events = [];
  const registry = {
    get: () => undefined,
    applyRealtimeEvent: (_id, event) => events.push(event),
  };
  const state = { calls: new Map() };

  service.ingestLine(registry, "ais_test", JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "exit 1" } }] },
  }), state);
  service.ingestLine(registry, "ais_test", JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "failed" }] },
  }), state);

  assert.deepEqual(events, []);
});

test("transcript records with text and tools preserve only the assistant text", () => {
  const service = new AiSessionTranscriptService({ idleAfterMs: 1000, staleAfterMs: 60_000 });
  const events = [];
  const registry = {
    get: () => undefined,
    applyRealtimeEvent: (_id, event) => events.push(event),
  };

  service.ingestLine(registry, "ais_test", JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "text", text: "I will inspect the workspace." },
      { type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } },
    ] },
  }), { calls: new Map() });

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "assistant-message");
  assert.equal(events[0].text, "I will inspect the workspace.");
});

test("transcript scans only reactivate transcript-only sessions when file size grows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-transcript-service-"));
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hello" } })}\n`);
  const oldMtime = new Date("2026-07-17T23:59:50.000Z");
  fs.utimesSync(transcriptPath, oldMtime, oldMtime);
  let now = Date.parse("2026-07-18T00:00:00.000Z");
  const service = new AiSessionTranscriptService({ idleAfterMs: 1000, staleAfterMs: 60_000, now: () => now });
  let session;
  const registry = {
    get: (id) => session?.id === id ? session : undefined,
    findTranscriptSession: ({ transcriptPath: requestedPath, providerSessionId }) =>
      session && (session.transcriptPath === requestedPath || session.providerSessionId === providerSessionId) ? session : undefined,
    start: (input, options = {}) => {
      session = {
        id: "ais_test",
        ...input,
        startedAt: options.timestamp,
        updatedAt: options.timestamp,
        counters: { toolCalls: 0, edits: 0, approvals: 0 },
        queue: { messages: [] },
      };
      return session;
    },
    applyAdapterSnapshot: (snapshot) => {
      session = { ...session, ...snapshot, updatedAt: snapshot.observedAt };
      return session;
    },
  };

  service.createFromTranscript(registry, "codex", transcriptPath, { providerSessionId: "provider" });
  assert.equal(session.status, "idle");
  const firstUpdatedAt = session.updatedAt;

  const touched = new Date("2026-07-18T00:00:01.000Z");
  fs.utimesSync(transcriptPath, touched, touched);
  now = touched.getTime();
  service.createFromTranscript(registry, "codex", transcriptPath, { providerSessionId: "provider" });
  assert.equal(session.status, "idle");
  assert.equal(session.updatedAt, firstUpdatedAt);

  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "new" } })}\n`);
  now += 1000;
  service.createFromTranscript(registry, "codex", transcriptPath, { providerSessionId: "provider" });
  assert.equal(session.status, "running");
  assert.equal(session.updatedAt, new Date(now).toISOString());
});
