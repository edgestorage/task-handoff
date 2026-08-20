const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiSessionConversationAttachmentSchema,
  AiSessionRealtimeInputSchema,
  AiSessionStatusSchema,
  AiSessionSummarySchema,
} = require("../src/ai-sessions.ts");
const {
  normalizeControlledInstanceCapabilities,
  supportsAiSessionConversationAttachmentCapability,
  supportsAiSessionAttachmentRetentionSettings,
} = require("../src/control-plane.ts");

const attachment = { id: "att-a", kind: "image", name: "a.png", mime: "image/png", size: 4, contentState: "available" };

test("conversation attachment metadata excludes content, hashes, paths, and URLs", () => {
  assert.deepEqual(AiSessionConversationAttachmentSchema.parse(attachment), attachment);
  for (const forbidden of ["data", "hash", "path", "url", "source"]) {
    assert.throws(() => AiSessionConversationAttachmentSchema.parse({ ...attachment, [forbidden]: "secret" }));
  }
  assert.throws(() => AiSessionConversationAttachmentSchema.parse({ ...attachment, id: undefined }));
});

test("session detail and realtime user messages carry optional attachment metadata while list summaries do not", () => {
  const turn = { id: "turn-a", status: "running", revision: 1, userPrompt: "look", userMessages: [{ id: "message-a", text: "look", attachments: [attachment] }] };
  const base = { id: "session-a", agent: "codex", creationSource: "ai-session", status: "running", phase: "thinking", turns: [turn], toolCallsSinceLastMessage: 0, subAgents: [], queue: { revision: 0, items: [] }, startedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", counters: { toolCalls: 0, edits: 0, approvals: 0 } };
  assert.equal(AiSessionStatusSchema.parse(base).turns[0].userMessages[0].attachments[0].id, "att-a");
  assert.throws(() => AiSessionSummarySchema.parse(base));
  assert.equal(AiSessionRealtimeInputSchema.parse({ type: "event", sessionId: "session-a", kind: "send-ack", source: "control", userPrompt: "look", userMessage: turn.userMessages[0] }).userMessage.attachments[0].id, "att-a");
  assert.throws(() => AiSessionStatusSchema.parse({ ...base, turns: [{ ...turn, userMessages: [{ ...turn.userMessages[0], attachments: Array.from({ length: 21 }, (_, index) => ({ ...attachment, id: `att-${index}` })) }] }] }));
});

test("conversation attachment capabilities are additive and independently queryable", () => {
  const legacy = normalizeControlledInstanceCapabilities({ features: {} });
  assert.equal(supportsAiSessionConversationAttachmentCapability(legacy, "codex", "metadata"), false);
  const sanitizedLegacy = normalizeControlledInstanceCapabilities({ features: { futureFeature: true }, futureRoot: true });
  assert.equal(supportsAiSessionAttachmentRetentionSettings(sanitizedLegacy), false);
  const current = normalizeControlledInstanceCapabilities({ features: { aiSessionConversationAttachments: { metadataAgents: ["codex"], contentAgents: ["codex"], uploadAgents: [], retentionSettings: true } } });
  assert.equal(supportsAiSessionConversationAttachmentCapability(current, "codex", "metadata"), true);
  assert.equal(supportsAiSessionConversationAttachmentCapability(current, "claude", "metadata"), false);
  assert.equal(supportsAiSessionAttachmentRetentionSettings(current), true);
});
