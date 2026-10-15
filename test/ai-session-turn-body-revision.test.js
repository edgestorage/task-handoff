const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const { updateTurns } = require("../packages/ai-session-runtime/src/ai-session-turns.ts");
const { aiSessionTurnBodyRevision } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");

const T0 = "2026-10-15T05:00:00.000Z";
const T1 = "2026-10-15T05:00:30.000Z";
const T2 = "2026-10-15T05:01:00.000Z";

// A discovery scan re-observes the same Provider state on a fixed cadence, so the
// observation clock advances on every pass while the Turn body stays put. The body
// revision has to hold still: it is what projectAiSessionAuthorityChange compares to
// decide whether a Session summary must be re-published to Relay subscribers.
function scan(observedAt, snapshotVersion, overrides = {}) {
  return {
    patch: { activeTurnId: "turn-1", userPrompt: "hello", status: "running", phase: "thinking", ...overrides },
    meta: { source: "control", observedAt, snapshotVersion },
  };
}

function applyObservation(turns, observedAt, snapshotVersion, overrides) {
  const { patch, meta } = scan(observedAt, snapshotVersion, overrides);
  return updateTurns(turns, patch, observedAt, meta);
}

test("observing an unchanged Turn does not move its body revision", () => {
  let turns = applyObservation(undefined, T0, 1);
  const first = turns.at(-1);
  assert.equal(first.userPrompt, "hello");

  const revision = aiSessionTurnBodyRevision(first);
  for (const [observedAt, snapshotVersion] of [[T1, 2], [T2, 3]]) {
    turns = applyObservation(turns, observedAt, snapshotVersion);
    const next = turns.at(-1);
    assert.equal(aiSessionTurnBodyRevision(next), revision, `body revision moved at ${observedAt}`);
    assert.equal(next.revision, first.revision, `turn revision moved at ${observedAt}`);
    assert.equal(next.updatedAt, first.updatedAt, `turn updatedAt moved at ${observedAt}`);
    assert.equal(next.observedAt, observedAt, "the observation clock still advances");
  }
});

test("a discovery scan cadence of unchanged observations never republishes the latest Turn", () => {
  let turns = applyObservation(undefined, T0, 1);
  // summaryForHeartbeat publishes { id, bodyRevision } for the newest Turn; a moving
  // bodyRevision is what makes every Relay subscriber refetch the whole Session summary.
  const latestTurnRef = (list) => ({ id: list.at(-1).id, bodyRevision: aiSessionTurnBodyRevision(list.at(-1)) });

  const baseline = latestTurnRef(turns);
  for (const [observedAt, snapshotVersion] of [[T1, 2], [T2, 3]]) {
    turns = applyObservation(turns, observedAt, snapshotVersion);
    assert.deepEqual(latestTurnRef(turns), baseline, `latestTurnRef moved at ${observedAt}`);
  }
});

test("a real Turn body edit still moves the body revision", () => {
  const turns = applyObservation(undefined, T0, 1);
  const before = aiSessionTurnBodyRevision(turns.at(-1));

  const edited = applyObservation(turns, T1, 2, { userPrompt: "hello again" });
  const after = edited.at(-1);
  assert.notEqual(aiSessionTurnBodyRevision(after), before);
  assert.equal(after.updatedAt, T1);
  assert.equal(after.revision, turns.at(-1).revision + 1);
});

test("a Turn status change still moves the body revision", () => {
  const turns = applyObservation(undefined, T0, 1);
  const before = aiSessionTurnBodyRevision(turns.at(-1));

  const settled = applyObservation(turns, T1, 2, { status: "waiting" });
  assert.notEqual(aiSessionTurnBodyRevision(settled.at(-1)), before);
});

// Discovery scans re-observe provider state on a fixed cadence. Adapters and the
// Turn reducer advance the Turn's internal content clock (and the observation
// metadata) on those passes even when the body is untouched. A body revision that
// followed the clock made every Idle Session re-publish its summary — and its
// Relay subscribers refetch the Turn body — once per scan.
test("observation-only passes never move the body revision", () => {
  const settled = {
    id: "turn-1",
    providerTurnId: "turn-1",
    source: "adapter-snapshot",
    sourcePriority: 60,
    userPrompt: "hello",
    status: "completed",
    phase: "unknown",
    lastMessage: "world",
    lastMessageItemId: "part-1",
    revision: 63842,
    snapshotVersion: 1790098339453,
    observedAt: "2026-09-22T17:32:19.453Z",
    startedAt: "2026-09-22T17:32:09.957Z",
    updatedAt: "2026-09-22T17:32:19.450Z",
    completedAt: "2026-09-22T17:32:19.453Z",
  };
  const baseline = aiSessionTurnBodyRevision(settled);

  for (const revision of [63843, 63844, 70000]) {
    assert.equal(
      aiSessionTurnBodyRevision({ ...settled, revision }),
      baseline,
      `body revision followed the internal content clock at revision ${revision}`,
    );
  }
  assert.equal(aiSessionTurnBodyRevision({ ...settled, observedAt: "2026-10-15T06:32:02.468Z" }), baseline);
  assert.equal(aiSessionTurnBodyRevision({ ...settled, snapshotVersion: 1790098339454 }), baseline);

  assert.notEqual(aiSessionTurnBodyRevision({ ...settled, revision: 63843, lastMessage: "world!" }), baseline);
  assert.notEqual(aiSessionTurnBodyRevision({ ...settled, revision: 63843, status: "running" }), baseline);
  assert.notEqual(aiSessionTurnBodyRevision({ ...settled, revision: 63843, updatedAt: "2026-10-15T06:32:02.468Z" }), baseline);
});

// The registry publishes one `ai-session.patch` per changed Session summary. A
// Session that is only re-observed must therefore leave its summary — and in
// particular `latestTurnRef.bodyRevision` — untouched, otherwise every Idle
// Session broadcasts a multi-kilobyte patch to every Relay subscriber on every
// discovery scan.
test("a counter-only observation pass republishes no Session summary", () => {
  const { mkdtempSync } = fs;
  const os = require("node:os");
  const path = require("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "ais-body-rev-"));
  const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
  const { projectAiSessionAuthorityChange } = require("../packages/controlled-instance/src/web/ai-session-authority-events.ts");

  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const settled = registry.start({
    agent: "opencode",
    creationSource: "ai-session",
    providerSessionId: "ses_opencode_idle",
    cwd: "/workspace",
    title: "Idle session",
    userPrompt: "hello",
    status: "idle",
    turns: [{
      id: "turn-1",
      providerTurnId: "turn-1",
      source: "adapter-snapshot",
      userPrompt: "hello",
      status: "completed",
      phase: "unknown",
      lastMessage: "world",
      lastMessageItemId: "part-1",
      revision: 63842,
      snapshotVersion: 1790098339453,
      observedAt: "2026-09-22T17:32:19.453Z",
      startedAt: "2026-09-22T17:32:09.957Z",
      updatedAt: "2026-09-22T17:32:19.450Z",
      completedAt: "2026-09-22T17:32:19.453Z",
    }],
  });
  const id = registry.all().at(-1)?.id || settled?.id;
  const before = registry.snapshot();

  // Adapters advance the internal content clock and the observation metadata on
  // every scan; neither is part of the Turn body a client renders.
  const turn = registry.get(id).turns.at(-1);
  turn.revision += 1;
  turn.observedAt = "2026-10-15T06:32:02.468Z";
  turn.snapshotVersion = 1790098339454;

  assert.deepEqual(projectAiSessionAuthorityChange(before, registry.snapshot()), { kind: "unchanged" });

  // A real body edit still has to republish the Session.
  registry.get(id).turns.at(-1).lastMessage = "world!";
  const change = projectAiSessionAuthorityChange(before, registry.snapshot());
  assert.equal(change.kind, "patch");
  assert.deepEqual(change.upserted.map((session) => session.id), [id]);
});
