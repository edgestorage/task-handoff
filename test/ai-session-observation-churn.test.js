const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { projectAiSessionAuthorityChange } = require("../packages/controlled-instance/src/web/ai-session-authority-events.ts");

const PENDING = "Selected decision option: 不继续";

// Mirrors ais_b964ddaa26f74c7c9ee5.json: an idle codex-app-server Thread whose
// newest Turn carries a user prompt but no response yet. Provider discovery
// re-scans it every 30s and re-observes the very same Turns.
function adapterTurns() {
  return [
    {
      id: "01a10aa1-turn",
      status: "completed",
      revision: 0,
      startedAt: "2026-10-05T07:20:00.000Z",
      completedAt: "2026-10-05T07:21:00.000Z",
      updatedAt: "2026-10-05T07:21:00.000Z",
      userPrompt: "first",
      lastMessage: "answer",
      summary: "answer",
    },
    {
      id: "01a10af2-turn",
      status: "completed",
      revision: 0,
      startedAt: "2026-10-05T07:23:14.000Z",
      updatedAt: "2026-10-05T07:23:14.000Z",
      userPrompt: PENDING,
    },
  ];
}

function adapterScan(observedAt, turns = adapterTurns()) {
  return {
    source: "adapter-snapshot",
    agent: "codex",
    appId: "codex-app-server",
    providerSessionId: "thread-1",
    cwd: "/workspace",
    status: "idle",
    phase: "unknown",
    observedAt,
    userPrompt: PENDING,
    turns,
    replaceActivity: true,
  };
}

function createIdleSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ais-observation-churn-"));
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  registry.applyAdapterSnapshot(adapterScan("2026-10-15T07:59:30.000Z"));
  return { registry, id: registry.all().at(-1).id };
}

// A discovery scan re-observes Provider state on a fixed cadence. The Turn body
// does not move, but discovery re-stamps the Turn's observation metadata and the
// Session's updatedAt with the scan time. Treating that as business state made
// every Idle Session republish its whole summary (and refetch its Turn body) to
// every Relay subscriber once per scan.
test("an observation-only discovery scan leaves an idle Session untouched", () => {
  const { registry, id } = createIdleSession();
  const before = registry.snapshot();
  const settled = registry.get(id);

  registry.applyAdapterSnapshot(adapterScan("2026-10-15T08:00:00.000Z"));
  registry.applyAdapterSnapshot(adapterScan("2026-10-15T08:00:30.000Z"));
  assert.equal(registry.get(id), settled, "the Session object was rewritten by an observation-only scan");
  assert.equal(registry.get(id).updatedAt, "2026-10-15T07:59:30.000Z", "updatedAt followed the scan clock");
  assert.deepEqual(projectAiSessionAuthorityChange(before, registry.snapshot()), { kind: "unchanged" });
});

test("advancing the Turn observation metadata alone republishes nothing", () => {
  const { registry, id } = createIdleSession();
  const before = registry.snapshot();
  const turn = registry.get(id).turns.at(-1);

  turn.observedAt = "2026-10-15T08:00:30.000Z";
  turn.snapshotVersion = 42;
  turn.revision += 1;

  assert.deepEqual(projectAiSessionAuthorityChange(before, registry.snapshot()), { kind: "unchanged" });
});

test("a real provider-side Turn change still republishes the Session", () => {
  const { registry, id } = createIdleSession();
  const before = registry.snapshot();

  const completed = adapterTurns();
  completed[1] = { ...completed[1], lastMessage: "done", summary: "done", completedAt: "2026-10-15T08:00:30.000Z" };
  registry.applyAdapterSnapshot(adapterScan("2026-10-15T08:00:30.000Z", completed));

  const change = projectAiSessionAuthorityChange(before, registry.snapshot());
  assert.equal(change.kind, "patch");
  assert.deepEqual(change.upserted.map((session) => session.id), [id]);
});

test("a newly observed Turn still republishes the Session", () => {
  const { registry, id } = createIdleSession();
  const before = registry.snapshot();

  const withNewTurn = adapterTurns();
  withNewTurn.push({
    id: "01a10b03-turn",
    status: "completed",
    revision: 0,
    startedAt: "2026-10-15T08:00:00.000Z",
    completedAt: "2026-10-15T08:00:30.000Z",
    updatedAt: "2026-10-15T08:00:30.000Z",
    userPrompt: "next question",
    lastMessage: "next answer",
    summary: "next answer",
  });
  registry.applyAdapterSnapshot(adapterScan("2026-10-15T08:00:30.000Z", withNewTurn));

  assert.equal(registry.get(id).turns.length, 3);
  const change = projectAiSessionAuthorityChange(before, registry.snapshot());
  assert.equal(change.kind, "patch");
  assert.deepEqual(change.upserted.map((session) => session.id), [id]);
});
