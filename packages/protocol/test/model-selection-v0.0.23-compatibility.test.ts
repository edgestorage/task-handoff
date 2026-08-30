import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelSelectionSchema,
  NodeModelAssignmentSchema,
  normalizeNodeAgentCapabilities,
  sanitizeStoredControlledInstance,
  supportsNodeMultiEntityModelAssignment,
  supportsNodePrivateModelCatalog,
} from "../src/control-plane.ts";
import {
  AiSessionCreateInputSchema,
  AiSessionHistoryItemSchema,
  AiSessionModelSelectionInputSchema,
  AiSessionRealtimeInputSchema,
  AiSessionStatusSchema,
  AiSessionSummarySchema,
} from "../src/ai-sessions.ts";
import {
  normalizeAiSessionModelSelectionCapabilities,
  normalizeAiSessionReasoningEffortCapabilities,
} from "../src/ai-session-provider-capabilities.ts";

const now = "2026-08-27T00:00:00.000Z";
const selection = { modelEntityId: "mdl_entity_one", modelName: "gpt-5.6" };

test("v0.0.23 model assignments normalize to an ordered entity list without losing legacy hashes", () => {
  assert.deepEqual(ModelSelectionSchema.parse({
    modelEntityIds: ["mdl_one", "mdl_two", "mdl_one"],
    codexModelHash: "mdl_hash_one",
  }), {
    modelEntityIds: ["mdl_one", "mdl_two"],
    codexModelHash: "mdl_hash_one",
  });
  assert.deepEqual(NodeModelAssignmentSchema.parse({
    instanceId: "inst_one",
    codexModelHash: "mdl_hash_one",
    updatedAt: now,
  }), {
    instanceId: "inst_one",
    modelEntityIds: ["mdl_hash_one"],
    codexModelHash: "mdl_hash_one",
    updatedAt: now,
  });
});

test("unreleased active model overlay fields are removed at the stored instance boundary", () => {
  const sanitized = sanitizeStoredControlledInstance({
    id: "inst_one",
    modelSelection: {
      modelEntityIds: ["mdl_one", "mdl_one"],
      activeModelEntityId: "mdl_one",
      activeModelName: "gpt-5.6",
    },
  }) as Record<string, unknown>;
  assert.deepEqual(sanitized.modelSelection, { modelEntityIds: ["mdl_one"] });
});

test("model capabilities default to unsupported for v0.0.23 peers and ignore future fields", () => {
  assert.equal(supportsNodeMultiEntityModelAssignment({}), false);
  assert.equal(supportsNodePrivateModelCatalog({ folderPlaces: true }), false);
  const node = normalizeNodeAgentCapabilities({
    managedModels: { multiEntityAssignment: true, privateModelCatalog: true, future: true },
    future: true,
  });
  assert.deepEqual(node.managedModels, { multiEntityAssignment: true, privateModelCatalog: true });

  assert.deepEqual(normalizeAiSessionModelSelectionCapabilities({
    agent: "codex",
    actions: {},
    timeline: {},
  }), {
    selectModelAtCreate: false,
    selectProviderAtCreate: false,
    switchModelWithinProvider: false,
    switchProviderDuringSession: false,
  });
  assert.deepEqual(normalizeAiSessionModelSelectionCapabilities({
    agent: "codex",
    actions: {},
    timeline: {},
    modelSelection: {
      selectModelAtCreate: true,
      selectProviderAtCreate: true,
      switchModelWithinProvider: true,
      switchProviderDuringSession: false,
      future: true,
    },
  }), {
    selectModelAtCreate: true,
    selectProviderAtCreate: true,
    switchModelWithinProvider: true,
    switchProviderDuringSession: false,
  });
  assert.deepEqual(normalizeAiSessionReasoningEffortCapabilities({
    agent: "codex",
    actions: {},
    timeline: {},
  }), {
    selectAtCreate: false,
    updateDuringSession: false,
  });
  assert.deepEqual(normalizeAiSessionReasoningEffortCapabilities({
    agent: "codex",
    actions: {},
    timeline: {},
    reasoningEffort: { selectAtCreate: true, updateDuringSession: true, future: true },
  }), {
    selectAtCreate: true,
    updateDuringSession: true,
  });
});

test("AI Session model selection is a strict minimal public identity across create, state, history and events", () => {
  const create = AiSessionCreateInputSchema.parse({
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    clientRequestId: "request_one",
    message: "hello",
    attachments: [],
    references: [],
    modelSelection: selection,
  });
  assert.deepEqual(create.modelSelection, selection);
  assert.deepEqual(AiSessionModelSelectionInputSchema.parse({
    clientRequestId: "request_two",
    modelSelection: selection,
  }).modelSelection, selection);
  assert.equal(AiSessionModelSelectionInputSchema.safeParse({
    clientRequestId: "request_two",
    modelSelection: { ...selection, endpoint: "https://must-not-cross.example" },
  }).success, false);

  const status = AiSessionStatusSchema.parse({
    id: "session_one",
    agent: "codex",
    startedAt: now,
    updatedAt: now,
    modelSelection: selection,
  });
  assert.deepEqual(status.modelSelection, selection);
  assert.deepEqual(AiSessionSummarySchema.parse({
    id: status.id,
    agent: status.agent,
    creationSource: status.creationSource,
    status: status.status,
    phase: status.phase,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    modelSelection: status.modelSelection,
  }).modelSelection, selection);
  assert.deepEqual(AiSessionHistoryItemSchema.parse({
    id: "session_one",
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread_one",
    cwd: "/workspace",
    lastActiveAt: now,
    archivedAt: now,
    modelSelection: selection,
  }).modelSelection, selection);

  assert.deepEqual(AiSessionRealtimeInputSchema.parse({
    type: "event",
    source: "realtime",
    sessionId: "session_one",
    kind: "model-selection",
    modelSelection: selection,
  }).modelSelection, selection);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({
    type: "event",
    source: "realtime",
    sessionId: "session_one",
    kind: "model-selection",
  }).success, false);
});
