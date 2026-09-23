import assert from "node:assert/strict";
import test from "node:test";
import { StoryAiSessionCloseService } from "../src/node-agent/stories/ai-session-close-service.ts";

test("Story AI Session close uses the guarded controlled-instance endpoint", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const service = new StoryAiSessionCloseService(async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ data: { disposition: "closed" } }), { status: 200 });
  }, async () => "http://instance.local");

  await service.close({
    instance: { id: "instance_1", registrationToken: "secret" } as any,
    sessionId: "session/1",
    storyId: "story_1",
  });

  assert.equal(request?.url, "http://instance.local/api/internal/node-agent/ai-sessions/session%2F1/close-for-story-deletion");
  assert.equal(request?.init?.method, "POST");
  assert.equal((request?.init?.headers as Record<string, string>).authorization, "Bearer secret");
  const body = JSON.parse(String(request?.init?.body));
  assert.equal(body.storyId, "story_1");
  assert.equal(typeof body.clientRequestId, "string");
});

test("Story AI Session close rejects unsuccessful controlled-instance responses", async () => {
  const service = new StoryAiSessionCloseService(
    async () => new Response(null, { status: 409 }),
    async () => "http://instance.local",
  );
  await assert.rejects(() => service.close({
    instance: { id: "instance_1", registrationToken: "secret" } as any,
    sessionId: "session_1",
    storyId: "story_1",
  }), /HTTP 409/);
});
