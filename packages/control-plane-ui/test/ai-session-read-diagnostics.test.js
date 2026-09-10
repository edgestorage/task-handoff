import assert from "node:assert/strict";
import test from "node:test";
import { createAiSessionReadDiagnostics } from "../src/apps/control-plane/aiSessionReadDiagnostics.ts";

test("read diagnostics stay off unless explicitly enabled", () => {
  const entries = [];
  createAiSessionReadDiagnostics(false, (entry) => entries.push(entry))("turn.requested", { sessionId: "session" });
  assert.deepEqual(entries, []);
});

test("desktop diagnostic chunks fit v0.0.28's 240-character IPC limit without losing revisions", () => {
  const entries = [];
  const record = createAiSessionReadDiagnostics(true, (message, instanceId) => entries.push({ message, instanceId }), "11111111-1111-1111-1111-111111111111");
  const fields = { instanceId: "instance", sessionId: "session", key: "key".repeat(180), cachedRevision: "R1", desiredRevision: "R2", reused: false };
  record("deduplicate", fields);
  assert.ok(entries.length > 1);
  assert.ok(entries.every((entry) => entry.message.length <= 240 && entry.instanceId === "instance"));
  const text = entries.map((entry) => entry.message.match(/^ai-session-read \S+ \d+\/\d+ ([\s\S]*)$/)[1]).join("");
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, { time: parsed.time, event: "deduplicate", ...fields });
  assert.ok(Number.isFinite(Date.parse(parsed.time)));
});

test("diagnostic sink failures cannot interrupt session reads", () => {
  const record = createAiSessionReadDiagnostics(true, () => { throw new Error("unavailable"); });
  assert.doesNotThrow(() => record("turn.response", { responseRevision: "R1" }));
});
