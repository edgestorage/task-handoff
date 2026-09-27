import assert from "node:assert/strict";
import test from "node:test";
import { StoryToolPolicyService } from "../src/node-agent/stories/tool-policy-service.ts";
import { AgentDefinitionService } from "../src/node-agent/agents/service.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const definitionFields = {
  name: "Entry",
  description: "",
  appendedPrompt: "",
  targetInstanceId: "instance_one",
  cwdFolderId: "folder_one",
  providerId: "codex",
  executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  callableAgentIds: [],
} as const;

test("Story tool policy defaults, persists, resolves, and filters archived mutations", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-tool-policy-");
  try {
    const timestamp = "2026-09-19T00:00:00.000Z";
    await fixture.repository.stories.insert({
      id: "story_policy",
      title: "Policy",
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: 5,
      nextDocumentSequence: 1,
    });
    const service = new StoryToolPolicyService(fixture.repository);
    const initial = await service.settings("story_policy");
    assert.deepEqual(initial.policy, { content: true, actions: false, automations: false, aiSessions: false });
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual((await service.resolve("story_policy")).agentInvocation, {
      enabledTools: [],
      allowedAgentIds: [],
    });

    const updated = await service.update("story_policy", { content: true, actions: true, automations: true, aiSessions: true });
    assert.notEqual(updated.revision, initial.revision);
    assert.deepEqual((await service.resolve("story_policy")).enabledTools, [
      "story_list_content", "story_get_content", "story_set_content",
      "story_list_actions", "story_run_action",
      "story_list_automations", "story_create_automation", "story_update_automation",
      "story_delete_automation", "story_run_automation", "story_list_automation_runs",
      "story_list_ai_sessions", "story_get_ai_session", "story_get_ai_session_turn",
    ]);

    await fixture.repository.stories.update("story_policy", { archivedAt: timestamp });
    assert.deepEqual((await service.resolve("story_policy")).enabledTools, [
      "story_list_content", "story_get_content", "story_list_actions", "story_list_automations",
      "story_list_automation_runs", "story_list_ai_sessions", "story_get_ai_session", "story_get_ai_session_turn",
    ]);
    await assert.rejects(
      () => service.assertEnabled("story_policy", "story_run_action"),
      (error: any) => error.code === "STORY_AGENT_TOOL_DISABLED" && error.statusCode === 403,
    );
  } finally {
    await fixture.close();
  }
});

test("Story policy resolves only available entry Agents and isolates Stories", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-agent-policy-");
  try {
    const timestamp = "2026-09-26T00:00:00.000Z";
    for (const id of ["story_a", "story_b"]) {
      await fixture.repository.stories.insert({
        id,
        title: id,
        createdAt: timestamp,
        updatedAt: timestamp,
        maxIdleAiSessions: 5,
        nextDocumentSequence: 1,
      });
    }
    const first = fixture.repository.agents.definitions.insert({ id: "agent_first", ...definitionFields }, timestamp);
    const second = fixture.repository.agents.definitions.insert({ id: "agent_second", ...definitionFields, name: "Second" }, timestamp);
    fixture.repository.agents.storyEntries.replace("story_a", [second.id, first.id]);
    const service = new StoryToolPolicyService(fixture.repository);

    const resolved = await service.resolve("story_a");
    assert.deepEqual(resolved.agentInvocation, {
      enabledTools: ["agent_run"],
      allowedAgentIds: [first.id, second.id],
    });
    assert.deepEqual((await service.resolve("story_b")).agentInvocation, {
      enabledTools: [],
      allowedAgentIds: [],
    });

    fixture.repository.agents.definitions.delete(second.id);
    const afterDelete = await service.resolve("story_a");
    assert.deepEqual(afterDelete.agentInvocation.allowedAgentIds, [first.id]);
    assert.notEqual(afterDelete.revision, resolved.revision);
  } finally {
    await fixture.close();
  }
});

test("Story entry authorization does not restrict an entry Agent's callable relation", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-agent-callable-policy-");
  try {
    const timestamp = "2026-09-26T00:00:00.000Z";
    await fixture.repository.stories.insert({
      id: "story_entry_only",
      title: "Entry only",
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: 5,
      nextDocumentSequence: 1,
    });
    const downstream = fixture.repository.agents.definitions.insert({
      id: "agent_downstream",
      ...definitionFields,
      name: "Downstream",
    }, timestamp);
    const entry = fixture.repository.agents.definitions.insert({
      id: "agent_entry",
      ...definitionFields,
      callableAgentIds: [downstream.id],
    }, timestamp);
    fixture.repository.agents.storyEntries.replace("story_entry_only", [entry.id]);

    const storyPolicy = new StoryToolPolicyService(fixture.repository);
    const definitions = new AgentDefinitionService({} as never, fixture.repository.agents.definitions);
    assert.deepEqual((await storyPolicy.resolve("story_entry_only")).agentInvocation.allowedAgentIds, [entry.id]);
    assert.deepEqual(definitions.resolveInvocationTools(entry.id).allowedAgentIds, [downstream.id]);
  } finally {
    await fixture.close();
  }
});

test("Story tool policy fails closed for missing Stories and revocation is immediate", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-tool-policy-revoke-");
  try {
    const timestamp = "2026-09-19T00:00:00.000Z";
    await fixture.repository.stories.insert({
      id: "story_revoke",
      title: "Revoke",
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: 5,
      nextDocumentSequence: 1,
    });
    const service = new StoryToolPolicyService(fixture.repository);

    await service.assertEnabled("story_revoke", "story_get_content");
    await service.update("story_revoke", { content: false, actions: false, automations: false, aiSessions: false });
    await assert.rejects(
      () => service.assertEnabled("story_revoke", "story_get_content"),
      (error: any) => error.code === "STORY_AGENT_TOOL_DISABLED" && error.statusCode === 403,
    );
    await assert.rejects(
      () => service.resolve("story_from_another_node"),
      (error: any) => error.code === "STORY_NOT_FOUND" && error.statusCode === 404,
    );
  } finally {
    await fixture.close();
  }
});

test("multiple policy service consumers observe the same node-agent SQLite authority", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-tool-policy-shared-");
  try {
    const timestamp = "2026-09-19T00:00:00.000Z";
    await fixture.repository.stories.insert({
      id: "story_shared",
      title: "Shared",
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: 5,
      nextDocumentSequence: 1,
    });
    const first = new StoryToolPolicyService(fixture.repository);
    const second = new StoryToolPolicyService(fixture.repository);

    const updated = await first.update("story_shared", { content: false, actions: true, automations: false, aiSessions: true });
    assert.deepEqual(await second.settings("story_shared"), updated);
    assert.deepEqual((await second.resolve("story_shared")).enabledTools, [
      "story_list_actions",
      "story_run_action",
      "story_list_ai_sessions",
      "story_get_ai_session",
      "story_get_ai_session_turn",
    ]);
  } finally {
    await fixture.close();
  }
});
