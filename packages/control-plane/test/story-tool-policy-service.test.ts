import assert from "node:assert/strict";
import test from "node:test";
import { StoryToolPolicyService } from "../src/node-agent/stories/tool-policy-service.ts";
import { AgentOrchestrationService } from "../src/node-agent/agents/orchestration-service.ts";
import { defaultAgentOrchestrationId, agentOrchestrationHasEdge } from "@task-handoff/protocol/agent-orchestrations";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const definitionFields = {
  name: "Entry",
  description: "",
  appendedPrompt: "",
  targetInstanceId: "instance_one",
  cwdFolderId: "folder_one",
  providerId: "codex",
  executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
} as const;

/** 定义与默认编排必须成对存在：测试直接走仓储时用这个 helper 复刻服务层的同一事务不变量。 */
function seedAgent(
  fixture: Awaited<ReturnType<typeof createStoryDatabaseFixture>>,
  timestamp: string,
  fields: { id: string } & Record<string, unknown>,
) {
  const { id, ...content } = fields;
  const definition = fixture.repository.agents.definitions.insert({ id, ...definitionFields, ...content } as never, timestamp);
  fixture.repository.agents.orchestrations.insert({ id: defaultAgentOrchestrationId(id), name: definition.name, agentIds: [id], edges: [] }, timestamp);
  return definition;
}

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
    assert.deepEqual(initial.policy, { content: true, actions: false, automations: false, aiSessions: false, decisions: false });
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual((await service.resolve("story_policy")).agentInvocation, {
      enabledTools: [],
      allowedTargets: [],
    });

    const updated = await service.update("story_policy", { content: true, actions: true, automations: true, aiSessions: true, decisions: false });
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
    const first = seedAgent(fixture, timestamp, { id: "agent_first" });
    const second = seedAgent(fixture, timestamp, { id: "agent_second", name: "Second" });
    fixture.repository.agents.storyEntries.replace("story_a", [
      { agentId: second.id, orchestrationId: defaultAgentOrchestrationId(second.id) },
      { agentId: first.id, orchestrationId: defaultAgentOrchestrationId(first.id) },
    ]);
    const service = new StoryToolPolicyService(fixture.repository);

    const resolved = await service.resolve("story_a");
    assert.deepEqual(resolved.agentInvocation, {
      enabledTools: ["agent_run"],
      allowedTargets: [
        { agentId: first.id, orchestrationId: defaultAgentOrchestrationId(first.id) },
        { agentId: second.id, orchestrationId: defaultAgentOrchestrationId(second.id) },
      ],
    });
    assert.deepEqual((await service.resolve("story_b")).agentInvocation, {
      enabledTools: [],
      allowedTargets: [],
    });

    fixture.repository.agents.definitions.delete(second.id);
    const afterDelete = await service.resolve("story_a");
    assert.deepEqual(afterDelete.agentInvocation.allowedTargets, [
      { agentId: first.id, orchestrationId: defaultAgentOrchestrationId(first.id) },
    ]);
    assert.notEqual(afterDelete.revision, resolved.revision);
  } finally {
    await fixture.close();
  }
});

test("Story entry authorization never widens beyond the bound orchestration's edges", async () => {
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
    const downstream = seedAgent(fixture, timestamp, { id: "agent_downstream", name: "Downstream" });
    const entry = seedAgent(fixture, timestamp, { id: "agent_entry" });
    const orchestrations = new AgentOrchestrationService(fixture.repository.agents.orchestrations, fixture.repository.agents.definitions);
    const entryOrchestrationId = defaultAgentOrchestrationId(entry.id);
    orchestrations.update(entryOrchestrationId, {
      expectedRevision: orchestrations.get(entryOrchestrationId).revision,
      agentIds: [entry.id, downstream.id],
      edges: [{ fromAgentId: entry.id, toAgentId: downstream.id }],
    });
    fixture.repository.agents.storyEntries.replace("story_entry_only", [
      { agentId: entry.id, orchestrationId: entryOrchestrationId },
    ]);

    const storyPolicy = new StoryToolPolicyService(fixture.repository);
    // Story 白名单只授权入口本身；下游调用只由 Run 绑定编排的连边决定，两者互不扩张。
    assert.deepEqual((await storyPolicy.resolve("story_entry_only")).agentInvocation.allowedTargets, [
      { agentId: entry.id, orchestrationId: entryOrchestrationId },
    ]);
    const orchestration = orchestrations.get(entryOrchestrationId);
    assert.equal(agentOrchestrationHasEdge(orchestration, entry.id, downstream.id), true);
    assert.equal(agentOrchestrationHasEdge(orchestration, downstream.id, entry.id), false);
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
    await service.update("story_revoke", { content: false, actions: false, automations: false, aiSessions: false, decisions: false });
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

    const updated = await first.update("story_shared", { content: false, actions: true, automations: false, aiSessions: true, decisions: false });
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
