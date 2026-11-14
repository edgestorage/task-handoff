const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const writeFileAtomic = require("write-file-atomic");
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
const { AiSessionPersistenceError, classifyAiSessionStorageFailure, isAiSessionStorageFailure } = require("../packages/ai-session-runtime/src/ai-session/file-store.ts");
const { SessionRenameIntentStore } = require("../packages/ai-session-runtime/src/session-title-coordinator.ts");

function root(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

function withWriteError(code, run) {
  const original = writeFileAtomic.sync;
  writeFileAtomic.sync = () => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
  try {
    return run();
  } finally {
    writeFileAtomic.sync = original;
  }
}

test("AI session storage failures are classified as structured 507/503 errors", () => {
  for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL"]) {
    const error = AiSessionPersistenceError.from(Object.assign(new Error(code), { code }), "ais_storage");
    assert.equal(error.code, "AI_SESSION_STORAGE_FULL");
    assert.equal(error.statusCode, 507);
    assert.equal(isAiSessionStorageFailure(error), true);
  }
  const nodeSqliteFull = AiSessionPersistenceError.from(Object.assign(new Error("database or disk is full"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 13,
    errstr: "database or disk is full",
  }), "ais_storage");
  assert.equal(nodeSqliteFull.code, "AI_SESSION_STORAGE_FULL");
  assert.equal(nodeSqliteFull.statusCode, 507);
  assert.equal(nodeSqliteFull.storageCode, "SQLITE_FULL");
  assert.equal(isAiSessionStorageFailure(nodeSqliteFull), true);
  for (const code of ["EIO", "EROFS"]) {
    const error = AiSessionPersistenceError.from(Object.assign(new Error(code), { code }), "ais_storage");
    assert.equal(error.code, "AI_SESSION_STORAGE_UNAVAILABLE");
    assert.equal(error.statusCode, 503);
    assert.equal(isAiSessionStorageFailure(error), true);
  }

  const other = AiSessionPersistenceError.from(Object.assign(new Error("permission denied"), { code: "EACCES" }), "ais_storage");
  assert.equal(other.code, "AI_SESSION_PERSISTENCE_FAILED");
  assert.equal(other.statusCode, 500);
  assert.equal(isAiSessionStorageFailure(other), false);

  const raw = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  assert.equal(isAiSessionStorageFailure(raw), true);
  assert.equal(classifyAiSessionStorageFailure(raw).statusCode, 507);
  assert.equal(classifyAiSessionStorageFailure(raw).code, "AI_SESSION_STORAGE_FULL");
  assert.equal(isAiSessionStorageFailure(Object.assign(new Error("denied"), { code: "EACCES" })), false);
});

test("realtime event persistence failures degrade without escaping the event callback", () => {
  const diagnostics = [];
  const registry = createAiSessionRegistry({ dir: path.join(root("ai-session-degrade"), "ai-sessions"), onDiagnostic: (event) => diagnostics.push(event) });
  const session = registry.start({ agent: "codex", providerSessionId: "thread_degrade" });

  const returned = withWriteError("ENOSPC", () => registry.applyRealtimeEvent(session.id, {
    kind: "assistant-message",
    text: "This response was not persisted.",
  }));

  assert.equal(returned.id, session.id);
  assert.equal(returned.lastMessage, undefined);
  assert.equal(registry.get(session.id).lastMessage, undefined);
  assert.equal(registry.persistenceSnapshot().degraded, true);
  const degraded = diagnostics.find((event) => event.code === "AI_SESSION_PERSISTENCE_DEGRADED");
  assert.equal(degraded.statusCode, 507);
  assert.equal(degraded.storageCode, "ENOSPC");
  assert.equal(degraded.message, "AI Session storage is full.");
  assert.equal(degraded.sessionId, session.id);
  assert.equal(degraded.operation, "realtime-event");
  assert.equal(degraded.source, "realtime");
  assert.equal(degraded.kind, "assistant-message");
  assert.equal(typeof degraded.observedAt, "string");

  assert.throws(
    () => withWriteError("ENOSPC", () => registry.patch(session.id, { unread: true })),
    (error) => error.code === "AI_SESSION_STORAGE_FULL" && error.statusCode === 507,
  );

  assert.throws(
    () => withWriteError("ENOSPC", () => registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text: "strict" }, { persistence: "strict" })),
    (error) => error.code === "AI_SESSION_STORAGE_FULL" && error.statusCode === 507,
  );

  const recovered = registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text: "Persisted again." });
  assert.equal(recovered.lastMessage, "Persisted again.");
  assert.equal(registry.persistenceSnapshot().degraded, false);
  assert.equal(registry.persistenceSnapshot().recoveredAt !== undefined, true);
  assert.equal(diagnostics.some((event) => event.code === "AI_SESSION_PERSISTENCE_RECOVERED"), true);
});

test("adapter snapshot failures keep the last persisted session", () => {
  const registry = createAiSessionRegistry({ dir: path.join(root("ai-session-snapshot-degrade"), "ai-sessions") });
  const session = registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread_snapshot_degrade",
    status: "idle",
  });

  const returned = withWriteError("EIO", () => registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread_snapshot_degrade",
    status: "running",
    summary: "Not persisted",
  }));
  assert.equal(returned.id, session.id);
  assert.equal(returned.status, "idle");
  assert.equal(registry.get(session.id).status, "idle");
  assert.equal(registry.persistenceSnapshot().lastFailure.statusCode, 503);
  assert.equal(registry.persistenceSnapshot().lastFailure.operation, "adapter-snapshot");

  const missing = withWriteError("ENOSPC", () => registry.applyAdapterSnapshot({
    agent: "codex",
    providerSessionId: "thread_never_persisted",
    status: "running",
  }));
  assert.equal(missing, undefined);
  assert.equal(registry.getByProviderSessionId("codex", "thread_never_persisted"), undefined);
});

test("non-storage persistence failures still escape event callbacks", () => {
  const diagnostics = [];
  const registry = createAiSessionRegistry({ dir: path.join(root("ai-session-non-storage"), "ai-sessions"), onDiagnostic: (event) => diagnostics.push(event) });
  const session = registry.start({ agent: "codex", providerSessionId: "thread_non_storage" });

  assert.throws(
    () => withWriteError("EACCES", () => registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text: "should fail" })),
    (error) => error.code === "AI_SESSION_PERSISTENCE_FAILED" && error.statusCode === 500,
  );
  assert.equal(registry.persistenceSnapshot().degraded, false);
  assert.equal(diagnostics.some((event) => event.code === "AI_SESSION_PERSISTENCE_DEGRADED"), false);
});

test("diagnostic listener failures never escape event callbacks", () => {
  const registry = createAiSessionRegistry({
    dir: path.join(root("ai-session-diagnostic-throw"), "ai-sessions"),
    onDiagnostic: () => {
      throw new Error("diagnostic boom");
    },
  });
  const session = registry.start({ agent: "codex", providerSessionId: "thread_diagnostic_throw" });

  const degraded = withWriteError("ENOSPC", () => registry.applyRealtimeEvent(session.id, {
    kind: "assistant-message",
    text: "not persisted",
  }));
  assert.equal(degraded.id, session.id);
  assert.equal(registry.persistenceSnapshot().degraded, true);

  const recovered = registry.applyRealtimeEvent(session.id, { kind: "assistant-message", text: "persisted again" });
  assert.equal(recovered.lastMessage, "persisted again");
  assert.equal(registry.persistenceSnapshot().degraded, false);
});

test("rename intent persistence failures restore the in-memory list", () => {
  const dir = root("ai-session-rename-intent");
  const store = new SessionRenameIntentStore(dir);
  const intent = {
    schemaVersion: 1,
    operationId: "rename_operation",
    clientRequestId: "client_rename",
    aiSessionId: "ais_rename",
    agent: "codex",
    providerSessionId: "thread_rename",
    appSessionId: "apps_rename",
    previousTitle: "before",
    targetTitle: "after",
    authority: "provider",
    phase: "prepared",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  try {
    assert.throws(() => store.put(intent), (error) => error.code === "ENOSPC");
    assert.equal(store.get(intent.operationId), undefined);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.writeFileSync = originalWrite;
  }

  store.put(intent);
  fs.writeFileSync = () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  try {
    assert.throws(() => store.remove(intent.operationId), (error) => error.code === "ENOSPC");
    assert.deepEqual(store.get(intent.operationId), intent);
  } finally {
    fs.writeFileSync = originalWrite;
  }
});
