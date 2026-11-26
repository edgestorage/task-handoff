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
      policy: { content: true, actions: true, automations: false, aiSessions: false, decisions: false, future: true },
      revision,
      enabledTools: ["story_list_content", "story_list_actions", "future_tool"],
      agentInvocation: { enabledTools: ["agent_run"], allowedTargets: [{ agentId: "agent_one", orchestrationId: "default:agent_one" }] },
      future: "ignored",
    } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  assert.deepEqual(await registration.resolveStoryAgentToolsForStory("story_one"), {
    storyId: "story_one",
    enabledTools: ["story_list_content", "story_list_actions", "agent_run"],
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

test("registration client fails the Story tool domain closed when the policy route is missing", async () => {
  const registration = client((async () => new Response(JSON.stringify({
    statusCode: 404,
    error: "Not Found",
    message: "Route not found",
  }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch);

  const access = await registration.resolveStoryAgentToolsForStory("story_one");
  assert.equal(access.source, "fail-closed");
  assert.deepEqual(access.enabledTools, []);
});

test("registration client keeps a structured missing Story in the same fail-closed domain", async () => {
  const registration = client((async () => new Response(JSON.stringify({
    error: { code: "STORY_NOT_FOUND", message: "Story was not found." },
  }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch);

  const access = await registration.resolveStoryAgentToolsForStory("story_other_node");
  assert.equal(access.source, "fail-closed");
  assert.deepEqual(access.enabledTools, []);
});

test("registration client resolves Story context only when the Node advertises session prompting", async () => {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const registration = client((async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: String(init?.method || "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith("/node-agent/instances/inst_one/capabilities")) {
      return Response.json({ data: { stories: { enabled: true, contextSettings: { settings: true, projects: true, sessionPrompting: true } } } });
    }
    return Response.json({ data: {
      protocolVersion: "2026-11-26",
      storyId: "story_one",
      nodeId: "node_one",
      purpose: "session-create",
      revision: 2,
      renderedContext: "## Story additional instructions\nKeep it",
      diagnostics: [],
      omittedProjectCount: 0,
      omittedSessionCount: 0,
      sessionCandidateWindowOmittedCount: 0,
      future: "ignored",
    } });
  }) as typeof fetch);

  assert.equal(await registration.supportsStoryContextPrompting(), true);
  assert.match(requests[0]!.url, /\/node-agent\/instances\/inst_one\/capabilities$/);
  assert.equal(requests[0]!.method, "GET");
  const resolved = await registration.resolveStoryContext("story_one", "session-create", { instanceId: "inst_one", sessionId: "session_one" });
  assert.equal(resolved.renderedContext, "## Story additional instructions\nKeep it");
  assert.match(requests[1]!.url, /\/instances\/inst_one\/stories\/story_one\/context\/resolve$/);
  assert.equal(requests[1]!.method, "POST");
  assert.deepEqual(requests[1]!.body, {
    purpose: "session-create",
    caller: { instanceId: "inst_one", sessionId: "session_one" },
    excludeSessionIds: [],
  });
});

test("registration client keeps the session path usable when the Node lacks Story context capability", async () => {
  let resolveCalls = 0;
  const registration = client((async (url: string | URL | Request) => {
    if (String(url).endsWith("/node-agent/instances/inst_one/capabilities")) return Response.json({ data: { stories: { enabled: true } } });
    resolveCalls += 1;
    return Response.json({ data: {} });
  }) as typeof fetch);

  assert.equal(await registration.supportsStoryContextPrompting(), false);
  assert.equal(await registration.supportsStoryContextPrompting(), false);
  assert.equal(resolveCalls, 0);
});

test("registration client rejects corrupted or cross-Story context responses", async () => {
  let response: unknown = {
    protocolVersion: "2026-11-26",
    storyId: "story_other",
    nodeId: "node_one",
    purpose: "session-create",
    revision: 1,
    renderedContext: "wrong",
    diagnostics: [],
    omittedProjectCount: 0,
    omittedSessionCount: 0,
    sessionCandidateWindowOmittedCount: 0,
  };
  const registration = client((async () => Response.json({ data: response })) as typeof fetch);
  await assert.rejects(
    () => registration.resolveStoryContext("story_one", "session-create"),
    (error: any) => error.code === "STORY_CONTEXT_SCOPE_MISMATCH" && error.statusCode === 502,
  );
  response = { storyId: "story_one", revision: "invalid" };
  await assert.rejects(() => registration.resolveStoryContext("story_one", "session-create"));
});
