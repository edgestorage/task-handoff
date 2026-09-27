import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerNodeStoryAgentEntryRoutes } from "../src/node-agent/agents/routes.ts";
import { AgentDefinitionService } from "../src/node-agent/agents/service.ts";
import { StoryAgentEntryService } from "../src/node-agent/agents/story-entry-service.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

function definitionState() {
  const instance = {
    id: "instance_one",
    nodeId: "node_1",
    runtimeId: "runtime_docker",
    workspace: { path: "/workspace" },
    runtime: { workspacePath: "/workspace" },
    source: { type: "local-folder", path: "/host/workspace" },
    capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
  };
  return {
    nodeId: "node_1",
    controlledInstances: { get: (id: string) => id === instance.id ? instance : undefined },
    requireInstance: (id: string) => {
      if (id !== instance.id) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return instance;
    },
    localFolders: { get: (id: string) => id === "folder_one" ? { id, path: "/host/workspace/app" } : undefined },
    requireRuntime: () => ({ type: "docker" }),
  };
}

async function createFixture() {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-agent-entries-");
  const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
  await stories.init();
  const story = await stories.create({ title: "Entry authorization", actions: [] });
  const definitions = new AgentDefinitionService(definitionState() as never, fixture.repository.agents.definitions);
  const first = definitions.create({
    name: "First",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
  });
  const second = definitions.create({
    name: "Second",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
  });
  const service = new StoryAgentEntryService(stories, definitions, fixture.repository.agents.storyEntries);
  return { ...fixture, stories, story, definitions, first, second, service };
}

test("Story Agent entry service controls revisions and projects dangling references", async () => {
  const fixture = await createFixture();
  try {
    const empty = await fixture.service.get(fixture.story.id);
    const saved = await fixture.service.update(fixture.story.id, {
      expectedRevision: empty.revision,
      agentIds: [fixture.second.id, fixture.first.id, fixture.first.id],
    });
    assert.deepEqual(saved.entries, [fixture.first.id, fixture.second.id].sort()
      .map((agentId) => ({ agentId, status: "available" })));
    assert.notEqual(saved.revision, empty.revision);

    await assert.rejects(
      () => fixture.service.update(fixture.story.id, { expectedRevision: empty.revision, agentIds: [] }),
      (error: any) => error.code === "STORY_AGENT_ENTRY_REVISION_CONFLICT"
        && error.details.actualRevision === saved.revision,
    );

    fixture.definitions.delete(fixture.second.id);
    const dangling = await fixture.service.get(fixture.story.id);
    assert.deepEqual(dangling.entries.find((entry) => entry.agentId === fixture.second.id), {
      agentId: fixture.second.id,
      status: "missing-reference",
    });

    // Existing dangling ids may be retained while another entry changes; a new missing id is rejected.
    const retained = await fixture.service.update(fixture.story.id, {
      expectedRevision: dangling.revision,
      agentIds: [fixture.second.id],
    });
    assert.deepEqual(retained.entries, [{ agentId: fixture.second.id, status: "missing-reference" }]);
    await assert.rejects(
      () => fixture.service.update(fixture.story.id, { expectedRevision: retained.revision, agentIds: ["agent_unknown"] }),
      (error: any) => error.code === "STORY_AGENT_ENTRY_AGENT_NOT_FOUND",
    );
  } finally { await fixture.close(); }
});

test("Story Agent entry changes notify only after a successful authoritative write", async () => {
  const fixture = await createFixture();
  try {
    const notifications: string[] = [];
    const service = new StoryAgentEntryService(
      fixture.stories,
      fixture.definitions,
      fixture.repository.agents.storyEntries,
      async (entries) => { notifications.push(entries.revision); },
    );
    const initial = await service.get(fixture.story.id);
    const saved = await service.update(fixture.story.id, {
      expectedRevision: initial.revision,
      agentIds: [fixture.first.id],
    });
    assert.deepEqual(notifications, [saved.revision]);

    await assert.rejects(
      () => service.update(fixture.story.id, { expectedRevision: initial.revision, agentIds: [] }),
      (error: any) => error.code === "STORY_AGENT_ENTRY_REVISION_CONFLICT",
    );
    assert.deepEqual(notifications, [saved.revision]);
  } finally { await fixture.close(); }
});

test("Story archive retains entry authorization and deletion clears it without deleting definitions", async () => {
  const fixture = await createFixture();
  try {
    const empty = await fixture.service.get(fixture.story.id);
    await fixture.service.update(fixture.story.id, { expectedRevision: empty.revision, agentIds: [fixture.first.id] });
    await fixture.stories.archive(fixture.story.id);
    assert.deepEqual((await fixture.service.get(fixture.story.id)).entries.map((entry) => entry.agentId), [fixture.first.id]);

    assert.equal(await fixture.stories.deleteRecord(fixture.story.id), true);
    assert.deepEqual(fixture.repository.agents.storyEntries.get(fixture.story.id).agentIds, []);
    assert.equal(fixture.definitions.get(fixture.first.id).id, fixture.first.id);
    await assert.rejects(
      () => fixture.service.get(fixture.story.id),
      (error: any) => error.code === "STORY_AGENT_ENTRY_STORY_NOT_FOUND" && error.statusCode === 404,
    );
  } finally { await fixture.close(); }
});

test("Story Agent entries participate in outer transactions and tolerate future columns", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(() => fixture.repository.transactionSync((repository) => {
      repository.agents.storyEntries.replace(fixture.story.id, [fixture.first.id]);
      throw new Error("abort");
    }), /abort/);
    assert.deepEqual(fixture.repository.agents.storyEntries.get(fixture.story.id).agentIds, []);

    const diagnostics: Array<Record<string, unknown>> = [];
    fixture.repository.agents.storyEntries.setDiagnostic((_message, details) => diagnostics.push(details));
    fixture.database.client.exec("ALTER TABLE na_story_agent_entries ADD COLUMN future_state TEXT");
    fixture.repository.agents.storyEntries.replace(fixture.story.id, [fixture.first.id]);
    assert.deepEqual(fixture.repository.agents.storyEntries.get(fixture.story.id).agentIds, [fixture.first.id]);
    assert.deepEqual(diagnostics.at(-1)?.columns, ["future_state"]);
  } finally { await fixture.close(); }
});

test("Node-local Story Agent entry routes expose strict revision-controlled reads and writes", async () => {
  const fixture = await createFixture();
  const app = Fastify();
  registerNodeStoryAgentEntryRoutes(app, fixture.service);
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 400).send({
      error: { code: record.code ?? "VALIDATION_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) },
    });
  });
  try {
    const current = await app.inject({ method: "GET", url: `/api/node-agent/stories/${fixture.story.id}/agent-entries` });
    assert.equal(current.statusCode, 200);
    const revision = current.json().data.revision;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/node-agent/stories/${fixture.story.id}/agent-entries`,
      payload: { expectedRevision: revision, agentIds: [fixture.first.id] },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().data.entries, [{ agentId: fixture.first.id, status: "available" }]);

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/node-agent/stories/${fixture.story.id}/agent-entries`,
      payload: { expectedRevision: updated.json().data.revision, agentIds: [], nodeId: "node_other" },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
    await fixture.close();
  }
});
