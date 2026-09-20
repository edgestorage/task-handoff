import assert from "node:assert/strict";
import test from "node:test";
import { StoryToolPolicyInvalidationNotifier } from "../src/node-agent/stories/tool-policy-invalidation.ts";

const revision = "c".repeat(64);

function instance(id: string, storyIds: Array<string | undefined>, registrationToken?: string) {
  return {
    id,
    registrationToken,
    aiSessions: { sessions: storyIds.map((storyId, index) => ({ id: `session_${index}`, storyId })) },
  };
}

test("policy invalidation targets each controlled instance holding a matching Story session once", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const notifier = new StoryToolPolicyInvalidationNotifier(
    { listInstances: () => [
      instance("inst_one", ["story_one", "story_one"], "token_one"),
      instance("inst_two", ["story_other"], "token_two"),
      instance("inst_three", ["story_one"]),
    ] } as never,
    (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    async (target) => `http://${target.id}.example`,
    (data) => warnings.push(data),
  );

  await notifier.notify({ storyId: "story_one", revision });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://inst_one.example/api/internal/node-agent/story-agent-tools/invalidate");
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer token_one");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { storyId: "story_one", revision });
  assert.deepEqual(warnings, []);
});

test("policy invalidation reports delivery failures without rejecting the update", async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const notifier = new StoryToolPolicyInvalidationNotifier(
    { listInstances: () => [instance("inst_one", ["story_one"], "token_one")] } as never,
    (async () => new Response(null, { status: 503 })) as typeof fetch,
    async () => "http://instance.example",
    (data) => warnings.push(data),
  );

  await notifier.notify({ storyId: "story_one", revision });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.instanceId, "inst_one");
});
