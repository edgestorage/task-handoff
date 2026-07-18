import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AiSessionMessageDeltaEventSchema } from "../packages/protocol/src/ai-sessions.ts";

const fixturePath = new URL("./fixtures/ai-session/codex-markdown-stream.real.jsonl", import.meta.url);

test("real Codex stream fixture preserves identities, event order, and completed text", { skip: !existsSync(fixturePath) && "real fixture has not been recorded" }, async () => {
  const records = (await readFile(fixturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const [metadata, ...events] = records;
  assert.equal(metadata.provenance, "real-codex-app-server-websocket");
  assert.equal(metadata.transport, "websocket");
  const deltas = events.filter((event) => event.aiSessionEvent?.type === "ai-session.message-delta");
  assert.equal(deltas.length, metadata.rawDeltaCount);
  assert.ok(deltas.length >= 20, `expected at least 20 real deltas, received ${deltas.length}`);
  for (const event of deltas) {
    assert.equal(AiSessionMessageDeltaEventSchema.safeParse(event.aiSessionEvent.payload).success, true);
    assert.equal(event.aiSessionEvent.payload.instanceId, metadata.instanceId);
    assert.equal(event.aiSessionEvent.payload.sessionId, metadata.sessionId);
    assert.equal(event.aiSessionEvent.payload.providerSessionId, metadata.providerSessionId);
    assert.equal(event.aiSessionEvent.payload.turnId, metadata.turnId);
  }
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].elapsedMs >= events[index - 1].elapsedMs, "events must retain arrival order");
  }
  const completedIndex = events.findIndex((event) => event.raw.method === "item/completed");
  const turnCompletedIndex = events.findIndex((event) => event.raw.method === "turn/completed");
  assert.ok(completedIndex > events.lastIndexOf(deltas.at(-1)), "agent completion must follow all deltas");
  assert.ok(turnCompletedIndex > completedIndex, "turn completion must follow agent completion");
  const completedText = events[completedIndex].raw.params.item.text;
  assert.equal(deltas.map((event) => event.aiSessionEvent.payload.delta).join(""), completedText);
  assert.match(completedText, /```(?:ts|typescript)\n[\s\S]+?```/);
  assert.match(completedText, /\|[^\n]+\|\n\|\s*:?-{3,}/);
  assert.match(completedText, /\$[^\n$]+\$/);
  assert.match(completedText, /\$\$[\s\S]+?\$\$/);
  assert.match(completedText, /```mermaid\n[\s\S]+?```/);
  assert.match(completedText, /👩🏽‍💻/u);
  assert.match(completedText, /STREAM_FIXTURE_COMPLETE/);
});
