import assert from "node:assert/strict";
import test from "node:test";
import { NodeAgentRegistrationClient } from "../src/web/node-agent-client.ts";

const revision = "d".repeat(64);
const snapshot = async () => ({}) as never;

function client(fetchImpl: typeof fetch) {
  return new NodeAgentRegistrationClient({
    controlMode: "controlled",
    nodeAgentUrl: "http://node-agent.example",
    registrationToken: "registration-token",
    instanceId: "inst_one",
    heartbeatIntervalMs: 10_000,
  }, snapshot, fetchImpl);
}

test("registration client fetches, sanitizes, caches, and invalidates Story tool permissions", async () => {
  const requests: string[] = [];
  const registration = client((async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ data: {
      storyId: "story_one",
      policy: { content: true, actions: true, automations: false, aiSessions: false, future: true },
      revision,
      enabledTools: ["story_list_content", "story_list_actions", "future_tool"],
      future: "ignored",
    } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  assert.deepEqual(await registration.resolveStoryAgentToolsForStory("story_one"), {
    storyId: "story_one",
    enabledTools: ["story_list_content", "story_list_actions"],
    revision,
    source: "node-agent",
  });
  assert.match(requests[0] || "", /\/instances\/inst_one\/story-agent-tools\?storyId=story_one$/);
  assert.equal(registration.storyAgentToolCapability(), "supported");
  assert.equal(registration.cachedStoryAgentTools("story_one")?.revision, revision);
  assert.equal(registration.invalidateStoryAgentTools({ storyId: "story_one", revision: "e".repeat(64) }), true);
  assert.equal(registration.cachedStoryAgentTools("story_one"), undefined);
});

test("registration client fails closed only the Story tool domain on invalid responses", async () => {
  const registration = client((async () => new Response(JSON.stringify({ data: {
    storyId: "story_one",
    enabledTools: ["story_list_content"],
  } }), { headers: { "content-type": "application/json" } })) as typeof fetch);

  const access = await registration.resolveStoryAgentToolsForSession("session_one", "story_one");
  assert.equal(access.source, "fail-closed");
  assert.deepEqual(access.enabledTools, []);
  assert.match(access.diagnostic || "", /revision|policy/i);
});

test("registration client preserves the v0.0.32 Content-only compatibility profile", async () => {
  const registration = client((async () => new Response(JSON.stringify({
    statusCode: 404,
    error: "Not Found",
    message: "Route not found",
  }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch);

  assert.deepEqual(await registration.resolveStoryAgentToolsForStory("story_one"), {
    storyId: "story_one",
    enabledTools: ["story_list_content", "story_get_content", "story_set_content"],
    source: "legacy-v0.0.32",
  });
  assert.equal(registration.storyAgentToolCapability(), "legacy-content-only");
});

test("registration client does not treat a structured missing Story as a legacy node-agent", async () => {
  const registration = client((async () => new Response(JSON.stringify({
    error: { code: "STORY_NOT_FOUND", message: "Story was not found." },
  }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch);

  const access = await registration.resolveStoryAgentToolsForStory("story_other_node");
  assert.equal(access.source, "fail-closed");
  assert.deepEqual(access.enabledTools, []);
});
