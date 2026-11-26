import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { NodeLocalFolderSchema } from "@task-handoff/protocol/control-plane";
import {
  STORY_CONTEXT_CLOSED_SESSIONS_PROTOCOL_VERSION,
  STORY_CONTEXT_SESSION_CANDIDATE_LIMIT,
} from "@task-handoff/protocol/story-context";
import { StoryContextSettingsService } from "../src/stories/context-settings-service.ts";
import { StoryContextResolutionService } from "../src/stories/story-context-resolution-service.ts";
import { registerNodeStoryRoutes } from "../src/stories/routes.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const NOW = "2026-11-26T00:00:00.000Z";

function folder(id: string, name = id, folderPath = `/work/${name}`) {
  return NodeLocalFolderSchema.parse({
    id,
    nodeId: "node_1",
    name,
    path: folderPath,
    labels: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function session(id: string, input: Record<string, unknown> = {}) {
  return {
    id,
    agent: "codex",
    storyId: "story_1",
    status: "idle",
    startedAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function closedResult(storyId: string, sessions: unknown[]) {
  return {
    protocolVersion: STORY_CONTEXT_CLOSED_SESSIONS_PROTOCOL_VERSION,
    storyId,
    sessions,
    omittedCount: 0,
    diagnostics: [],
  };
}

async function fixture(options: {
  folders?: ReturnType<typeof folder>[];
  instances?: unknown[];
  memberSessionIds?: string[];
  fetchImpl?: typeof fetch;
} = {}) {
  const database = await createStoryDatabaseFixture("task-handoff-story-context-resolution-");
  await database.repository.stories.insert({
    id: "story_1",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    maxIdleAiSessions: 5,
    nextDocumentSequence: 1,
  });
  const folders = [...(options.folders || [])];
  const instances = [...(options.instances || [])];
  const state = {
    node: { id: "node_1" },
    listInstances: () => instances,
    resolveLocalFolder: (id: string) => folders.find((candidate) => candidate.id === id),
  };
  const settings = new StoryContextSettingsService(database.repository, "node_1", state as never);
  const resolve = new StoryContextResolutionService({
    state: state as never,
    settings,
    resolveInstanceWeb: async (instance) => `http://${instance.id}.test`,
    fetchImpl: options.fetchImpl,
    listAgentRunMemberSessionIds: () => options.memberSessionIds || [],
    closedSessionTimeoutMs: 50,
  });
  return {
    database,
    state,
    settings,
    resolve,
    instances,
    setFolders(next: ReturnType<typeof folder>[]) { folders.splice(0, folders.length, ...next); },
    async close() { await database.close(); },
  };
}

test("session-create resolution returns no injected context without settings and skips unavailable projects", async () => {
  const context = await fixture({ folders: [folder("folder_b", "Beta", "/work/beta")] });
  try {
    assert.equal((await context.resolve.resolve({ storyId: "story_1", purpose: "session-create", excludeSessionIds: [] })).renderedContext, "");
    await context.settings.update("story_1", {
      expectedRevision: 0,
      projectFolderIds: ["folder_b"],
      appendedPrompt: "Story rules",
    });
    context.setFolders([folder("folder_b", "Beta renamed", "/work/beta-new")]);
    const resolved = await context.resolve.resolve({ storyId: "story_1", purpose: "session-create", excludeSessionIds: [] });
    assert.match(resolved.renderedContext, /## Story additional instructions\nStory rules/);
    assert.match(resolved.renderedContext, /Beta renamed\n   Path: \/work\/beta-new/);

    context.setFolders([]);
    const missing = await context.resolve.resolve({ storyId: "story_1", purpose: "session-create", excludeSessionIds: [] });
    assert.equal(missing.renderedContext.includes("Beta renamed"), false);
    assert.equal(missing.omittedProjectCount, 1);
    assert.ok(missing.diagnostics.some((entry) => entry.code === "story-context-project-missing" && entry.resourceId === "folder_b"));
  } finally { await context.close(); }
});

test("Agent Run collection excludes caller, subagents, other Stories and Run members, then merges closed history deterministically", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const context = await fixture({
    memberSessionIds: ["member_session"],
    instances: [{
      id: "instance_1",
      registrationToken: "token_1",
      aiSessions: { sessions: [
        session("caller", { updatedAt: "2026-11-26T05:00:00.000Z", userPrompt: "caller request" }),
        session("subagent", { lineage: { kind: "subagent", parentProviderSessionId: "provider_parent" }, updatedAt: "2026-11-26T04:00:00.000Z" }),
        session("other_story", { storyId: "story_2", updatedAt: "2026-11-26T03:00:00.000Z" }),
        session("member_session", { updatedAt: "2026-11-26T02:00:00.000Z" }),
        session("active_new", { updatedAt: "2026-11-26T06:00:00.000Z", userPrompt: "new active", lastMessage: "active reply" }),
        session("duplicate", { updatedAt: "2026-11-26T01:00:00.000Z" }),
      ] },
    }],
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: closedResult("story_1", [
        {
          instanceId: "instance_1",
          sessionId: "closed_old",
          title: "Old closed",
          agent: "codex",
          status: "closed",
          userPrompt: "old request",
          lastResponse: "old response",
          lastActivityAt: "2026-11-26T00:00:00.000Z",
        },
        {
          instanceId: "instance_1",
          sessionId: "duplicate",
          title: "Closed duplicate",
          agent: "codex",
          status: "closed",
          lastActivityAt: "2026-11-26T01:00:00.000Z",
        },
      ]) });
    }) as typeof fetch,
  });
  try {
    const resolved = await context.resolve.resolve({
      storyId: "story_1",
      purpose: "agent-run",
      caller: { instanceId: "instance_1", sessionId: "caller" },
      excludeSessionIds: ["explicit_exclusion"],
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body.excludeSessionIds.sort(), ["caller", "explicit_exclusion", "member_session"]);
    assert.ok(resolved.renderedContext.indexOf("new active") < resolved.renderedContext.indexOf("old request"));
    assert.ok(resolved.renderedContext.indexOf("duplicate") < resolved.renderedContext.indexOf("old request"));
    assert.equal(resolved.renderedContext.includes("caller request"), false);
    assert.equal(resolved.renderedContext.includes("Closed duplicate"), false);
  } finally { await context.close(); }
});

test("Agent Run collection isolates per-instance failures and keeps the latest 200 candidates", async () => {
  const sessions = Array.from({ length: STORY_CONTEXT_SESSION_CANDIDATE_LIMIT + 7 }, (_, index) => session(`session_${index}`, {
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    userPrompt: `request ${index}`,
  }));
  const context = await fixture({
    instances: [
      { id: "instance_ok", registrationToken: "token_ok", aiSessions: { sessions } },
      { id: "instance_down", registrationToken: "token_down", aiSessions: { sessions: [] } },
    ],
    fetchImpl: (async (url) => {
      if (String(url).includes("instance_down")) throw new Error("offline");
      return Response.json({ data: closedResult("story_1", []) });
    }) as typeof fetch,
  });
  try {
    const resolved = await context.resolve.resolve({ storyId: "story_1", purpose: "agent-run", excludeSessionIds: [] });
    assert.equal(resolved.sessionCandidateWindowOmittedCount, 7);
    assert.ok(resolved.omittedSessionCount > 0);
    assert.ok(resolved.diagnostics.some((entry) => entry.code === "story-context-session-read-failed"));
    assert.match(resolved.renderedContext, /request 206/);
    assert.equal(resolved.renderedContext.includes("request 0\n"), false);
  } finally { await context.close(); }
});

test("Agent Run closed-history reads stay within the exclusion wire limit after caller and member filtering", async () => {
  const explicitExclusions = Array.from(
    { length: STORY_CONTEXT_SESSION_CANDIDATE_LIMIT },
    (_, index) => `excluded_${index}`,
  );
  const requestedExclusions: string[][] = [];
  const context = await fixture({
    memberSessionIds: ["member_session"],
    instances: [{
      id: "instance_1",
      registrationToken: "token_1",
      aiSessions: { sessions: [] },
    }],
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { excludeSessionIds: string[] };
      requestedExclusions.push(body.excludeSessionIds);
      if (body.excludeSessionIds.length > STORY_CONTEXT_SESSION_CANDIDATE_LIMIT) {
        return Response.json({ error: { code: "VALIDATION_ERROR", message: "too many exclusions" } }, { status: 400 });
      }
      return Response.json({ data: closedResult("story_1", [{
        instanceId: "instance_1",
        sessionId: "closed_kept",
        title: "Closed kept",
        agent: "codex",
        status: "closed",
        userPrompt: "kept request",
        lastActivityAt: "2026-11-26T00:00:00.000Z",
      }]) });
    }) as typeof fetch,
  });
  try {
    const resolved = await context.resolve.resolve({
      storyId: "story_1",
      purpose: "agent-run",
      caller: { instanceId: "instance_1", sessionId: "caller_session" },
      excludeSessionIds: explicitExclusions,
    });
    assert.equal(requestedExclusions.length, 1);
    assert.equal(requestedExclusions[0]!.length, STORY_CONTEXT_SESSION_CANDIDATE_LIMIT);
    assert.deepEqual(requestedExclusions[0]!.slice(0, 2), ["caller_session", "member_session"]);
    assert.equal(new Set(requestedExclusions[0]).size, requestedExclusions[0]!.length);
    assert.match(resolved.renderedContext, /kept request/);
    assert.equal(resolved.diagnostics.some((entry) => entry.code === "story-context-session-read-failed"), false);
  } finally { await context.close(); }
});

test("Agent Run collection waits independently for slow instances and does not serialize healthy reads", async () => {
  let healthyFinished = false;
  let slowFinished = false;
  const context = await fixture({
    instances: [
      { id: "instance_fast", registrationToken: "token_fast", aiSessions: { sessions: [] } },
      { id: "instance_slow", registrationToken: "token_slow", aiSessions: { sessions: [] } },
    ],
    fetchImpl: (async (url) => {
      if (String(url).includes("instance_fast")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        healthyFinished = true;
        return Response.json({ data: closedResult("story_1", []) });
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      slowFinished = true;
      throw new Error("timeout");
    }) as typeof fetch,
  });
  try {
    const resolved = await context.resolve.resolve({ storyId: "story_1", purpose: "agent-run", excludeSessionIds: [] });
    assert.equal(healthyFinished, true);
    assert.equal(slowFinished, false);
    assert.ok(resolved.diagnostics.some((entry) => entry.code === "story-context-session-read-failed" && entry.resourceId === "instance_slow"));
  } finally { await context.close(); }
});

test("Story context routes expose authoritative settings, revision conflicts, owner-node validation and registration auth", async () => {
  const changes: string[] = [];
  const context = await fixture({ folders: [folder("folder_a")] });
  const instance = { id: "instance_1", registrationToken: "token_1", aiSessions: { sessions: [] } };
  const state = {
    ...context.state,
    authenticateInstance(id: string, token?: string) {
      if (id !== instance.id || token !== instance.registrationToken) {
        throw Object.assign(new Error("Invalid registration token."), { code: "INSTANCE_REGISTRATION_TOKEN_INVALID", statusCode: 403 });
      }
      return instance;
    },
  };
  const settings = new StoryContextSettingsService(context.database.repository, "node_1", state as never, (storyId) => { changes.push(storyId); });
  const resolution = new StoryContextResolutionService({
    state: state as never,
    settings,
    resolveInstanceWeb: async () => "http://instance.test",
    fetchImpl: (async () => Response.json({ data: closedResult("story_1", []) })) as typeof fetch,
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const validation = Array.isArray((error as { issues?: unknown[] }).issues);
    return reply.code(validation ? 400 : (error as { statusCode?: number }).statusCode || 500).send({
      error: { code: validation ? "VALIDATION_ERROR" : (error as { code?: string }).code || "INTERNAL_ERROR", message: error.message },
    });
  });
  registerNodeStoryRoutes(app, state as never, {} as never, {
    contextSettings: settings,
    contextResolution: resolution,
  });
  try {
    const initial = await app.inject({ method: "GET", url: "/api/node-agent/stories/story_1/settings/context" });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.json().data.revision, 0);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/node-agent/stories/story_1/settings/context",
      payload: { expectedRevision: 0, projectFolderIds: ["folder_a"], appendedPrompt: "rules" },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().data.revision, 1);
    assert.deepEqual(changes, ["story_1"]);

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/node-agent/stories/story_1/settings/context",
      payload: { expectedRevision: 0, projectFolderIds: [], appendedPrompt: "stale" },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, "STORY_CONTEXT_REVISION_CONFLICT");

    const denied = await app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/stories/story_1/context/resolve",
      headers: { authorization: "Bearer wrong" },
      payload: { purpose: "session-create" },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/node-agent/instances/instance_1/stories/story_1/context/resolve",
      headers: { authorization: "Bearer token_1" },
      payload: { purpose: "session-create" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().data.storyId, "story_1");
    assert.equal(resolved.json().data.purpose, "session-create");
    assert.match(resolved.json().data.renderedContext, /rules/);
  } finally {
    await app.close();
    await context.close();
  }
});

test("Agent Run closed-history isolates wrong-Story and invalid instance responses", async () => {
  const context = await fixture({
    instances: [
      { id: "instance_wrong_story", registrationToken: "token_wrong", aiSessions: { sessions: [] } },
      { id: "instance_invalid", registrationToken: "token_invalid", aiSessions: { sessions: [] } },
    ],
    fetchImpl: (async (url) => {
      if (String(url).includes("instance_wrong_story")) {
        return Response.json({ data: closedResult("story_2", [{
          instanceId: "instance_wrong_story",
          sessionId: "foreign_session",
          title: "Foreign Story",
          agent: "codex",
          status: "closed",
          userPrompt: "must not leak",
          lastActivityAt: "2026-11-26T05:00:00.000Z",
        }]) });
      }
      return Response.json({ data: closedResult("story_1", [{
        instanceId: "instance_invalid",
        sessionId: "invalid_session",
        title: "Invalid",
        status: "closed",
        userPrompt: "must not leak",
        lastActivityAt: "not-a-timestamp",
      }]) });
    }) as typeof fetch,
  });
  try {
    const resolved = await context.resolve.resolve({ storyId: "story_1", purpose: "agent-run", excludeSessionIds: [] });
    assert.ok(resolved.diagnostics.some((entry) => entry.code === "story-context-session-wrong-story" && entry.resourceId === "instance_wrong_story"));
    assert.ok(resolved.diagnostics.some((entry) => entry.code === "story-context-session-read-failed" && entry.resourceId === "instance_invalid"));
    assert.equal(resolved.renderedContext.includes("must not leak"), false);
  } finally { await context.close(); }
});

test("concurrent Agent Run context requests do not serialize closed-history reads behind a shared lock", async () => {
  let activeReads = 0;
  let maxActiveReads = 0;
  const context = await fixture({
    instances: [{ id: "instance_1", registrationToken: "token_1", aiSessions: { sessions: [] } }],
    fetchImpl: (async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeReads -= 1;
      return Response.json({ data: closedResult("story_1", []) });
    }) as typeof fetch,
  });
  try {
    const [first, second] = await Promise.all([
      context.resolve.resolve({ storyId: "story_1", purpose: "agent-run", excludeSessionIds: [] }),
      context.resolve.resolve({ storyId: "story_1", purpose: "agent-run", excludeSessionIds: [] }),
    ]);
    assert.equal(maxActiveReads, 2);
    assert.equal(first.renderedContext, "");
    assert.equal(second.renderedContext, "");
  } finally { await context.close(); }
});
