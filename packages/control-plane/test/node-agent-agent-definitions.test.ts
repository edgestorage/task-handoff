import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";
import { AgentDefinitionService } from "../src/node-agent/agents/service.ts";
import { AgentOrchestrationService } from "../src/node-agent/agents/orchestration-service.ts";
import { registerNodeAgentDefinitionRoutes, registerNodeAgentOrchestrationRoutes } from "../src/node-agent/agents/routes.ts";
import { agentDefinitionRevision } from "../src/node-agent/persistence/agent-repository.ts";
import { normalizeNodeAgentCapabilities, supportsNodeAgentExecutionPolicy } from "@task-handoff/protocol/node-agent-capabilities";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { openNodeAgentDatabase } from "../src/node-agent/persistence/database.ts";
import { createNodeAgentRepository } from "../src/node-agent/persistence/repository.ts";
import { defaultAgentOrchestrationId, type AgentOrchestration } from "@task-handoff/protocol/agent-orchestrations";
import { sanitizeAgentDefinition, type AgentDefinition } from "@task-handoff/protocol/agent-definitions";

const timestamp = "2026-09-26T00:00:00.000Z";

/** provider 能力是完整的 capability document 片段：缺 actions/timeline 会被 normalize 归一为不支持。 */
function providerCapability(agent: string) {
  return { agent, actions: {}, timeline: {} };
}

const INSTANCES = {
  instance_docker: {
    id: "instance_docker",
    nodeId: "node_1",
    runtimeId: "runtime_docker",
    workspace: { path: "/legacy/workspace" },
    runtime: { workspacePath: "/runtime/workspace" },
    source: { type: "local-folder", path: "/host/workspace" },
    capabilities: { features: { aiSessionProviders: [providerCapability("codex"), providerCapability("claude")] } },
  },
  instance_local: {
    id: "instance_local",
    nodeId: "node_1",
    runtimeId: "runtime_local",
    workspace: { path: "/host" },
    runtime: {},
    source: { type: "git-repository", url: "https://example.test/repo.git" },
    capabilities: { features: { aiSessionProviders: [providerCapability("codex")] } },
  },
};

const FOLDERS: Record<string, { id: string; path: string }> = {
  folder_inside: { id: "folder_inside", path: "/host/workspace/packages/app" },
  folder_outside: { id: "folder_outside", path: "/host/elsewhere" },
  folder_free: { id: "folder_free", path: "/srv/anywhere" },
};

const RUNTIMES: Record<string, { type: string }> = {
  runtime_docker: { type: "docker" },
  runtime_local: { type: "local" },
};

function createState() {
  return {
    nodeId: "node_1",
    controlledInstances: { get: (id: string) => (INSTANCES as Record<string, unknown>)[id] },
    requireInstance(id: string) {
      const instance = (INSTANCES as Record<string, unknown>)[id];
      if (!instance) throw Object.assign(new Error("Instance not found."), { code: "NODE_INSTANCE_NOT_FOUND", statusCode: 404 });
      return instance;
    },
    localFolders: { get: (id: string) => FOLDERS[id] },
    resolveLocalFolder: (id: string) => FOLDERS[id],
    requireRuntime(id: string) {
      const runtime = RUNTIMES[id];
      if (!runtime) throw Object.assign(new Error("Runtime not found."), { code: "NODE_RUNTIME_NOT_FOUND", statusCode: 404 });
      return runtime;
    },
  };
}

async function createFixture() {
  const database = await createStoryDatabaseFixture("task-handoff-agent-definitions-");
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const publish = (type: string, payload: unknown) => events.push({ type, payload: payload as Record<string, unknown> });
  const orchestrations = new AgentOrchestrationService(database.repository.agents.orchestrations, database.repository.agents.definitions, publish);
  const service = new AgentDefinitionService(createState() as never, database.repository.agents.definitions, orchestrations, publish);
  const app = Fastify();
  registerNodeAgentDefinitionRoutes(app, service);
  registerNodeAgentOrchestrationRoutes(app, orchestrations);
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 500).send({ error: { code: record.code ?? "NODE_AGENT_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) } });
  });
  return {
    ...database,
    service,
    orchestrations,
    app,
    events,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

/** revision 是内容哈希：测试侧独立重建同一份内容，验证服务端没有把时间戳或 id 混进哈希。 */
function revisionOf(definition: AgentDefinition) {
  const { name, description, appendedPrompt, targetInstanceId, cwdFolderId, providerId, modelEntityId, modelName, reasoningEffort, permissionMode, executionPolicy } = definition;
  return agentDefinitionRevision({ name, description, appendedPrompt, targetInstanceId, cwdFolderId, providerId, modelEntityId, modelName, reasoningEffort, permissionMode, executionPolicy });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Reviewer",
    targetInstanceId: "instance_docker",
    cwdFolderId: "folder_inside",
    providerId: "codex",
    ...overrides,
  } as never;
}

function defaultOrchestration(fixture: Awaited<ReturnType<typeof createFixture>>, agentId: string): AgentOrchestration {
  return fixture.orchestrations.get(defaultAgentOrchestrationId(agentId));
}

/** 环路报告的起点取决于节点 id 排序，先旋转到字典序最小节点再比较同一条定向环。 */
function canonicalCycle(cycle: string[]): string[] {
  const nodes = cycle.slice(0, -1);
  let start = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index] < nodes[start]) start = index;
  }
  const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
  return [...rotated, rotated[0]];
}

test("AgentDefinition repository derives revision from content and rejects stale writes", async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.service.create(input());
    assert.match(created.id, /^agent_[0-9abcdefghjkmnpqrstvwxyz]{13}$/);
    assert.equal(created.revision, revisionOf(created));
    assert.deepEqual(created.executionPolicy, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" });

    const updated = fixture.service.update(created.id, { expectedRevision: created.revision, name: "Senior Reviewer" } as never);
    assert.equal(updated.name, "Senior Reviewer");
    assert.notEqual(updated.revision, created.revision);

    assert.throws(
      () => fixture.service.update(created.id, { expectedRevision: created.revision, name: "Stale" } as never),
      (error: any) => {
        assert.equal(error.code, "AGENT_DEFINITION_REVISION_CONFLICT");
        assert.equal(error.statusCode, 409);
        assert.deepEqual(error.details, { code: "AGENT_DEFINITION_REVISION_CONFLICT", expectedRevision: created.revision, actualRevision: updated.revision });
        return true;
      },
    );

    // 重复提交相同内容不产生新的修订，内容哈希与时间戳无关。
    const same = fixture.service.update(updated.id, { expectedRevision: updated.revision, name: "Senior Reviewer" } as never);
    assert.equal(same.revision, updated.revision);
  } finally { await fixture.close(); }
});

test("Agent creation writes its default orchestration in the same transaction", async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.service.create(input());
    const orchestration = defaultOrchestration(fixture, created.id);
    assert.equal(orchestration.id, defaultAgentOrchestrationId(created.id));
    assert.deepEqual(orchestration.agentIds, [created.id]);
    assert.deepEqual(orchestration.edges, []);
    assert.match(orchestration.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(fixture.events.map((event) => [event.type, event.payload.change]), [
      ["agent.definition.changed", "created"],
      ["agent.orchestration.changed", "created"],
    ]);

    // 事务回滚时定义与默认编排一起消失，不留下半份状态。
    assert.throws(() => fixture.repository.agents.definitions.transaction(() => {
      fixture.service.create(input({ name: "Rolled back" }));
      throw new Error("boom");
    }), /boom/);
    assert.equal(fixture.service.list().length, 1);
    assert.equal(fixture.orchestrations.list().length, 1);
  } finally { await fixture.close(); }
});

test("AgentDefinition service validates instance, folder, provider and published policy", async () => {
  const fixture = await createFixture();
  try {
    const expectError = (fn: () => unknown, code: string, statusCode: number) => {
      assert.throws(fn, (error: any) => {
        assert.equal(error.code, code, error.message);
        assert.equal(error.statusCode, statusCode);
        return true;
      });
    };
    expectError(() => fixture.service.create(input({ targetInstanceId: "instance_other_node" })), "AGENT_DEFINITION_TARGET_INSTANCE_UNKNOWN", 404);
    expectError(() => fixture.service.create(input({ cwdFolderId: "folder_missing" })), "AGENT_DEFINITION_FOLDER_UNKNOWN", 404);
    expectError(() => fixture.service.create(input({ cwdFolderId: "folder_outside" })), "AGENT_DEFINITION_FOLDER_UNKNOWN", 409);
    expectError(() => fixture.service.create(input({ providerId: "opencode" })), "AGENT_DEFINITION_PROVIDER_UNSUPPORTED", 409);
    expectError(
      () => fixture.service.create(input({ executionPolicy: { workspaceMaterializer: "worktree", processSandbox: "instance" } })),
      "AGENT_DEFINITION_POLICY_UNSUPPORTED",
      409,
    );

    // Local Runtime 实例不限制文件夹必须落在实例来源目录内。
    const local = fixture.service.create(input({ targetInstanceId: "instance_local", cwdFolderId: "folder_free" }));
    assert.equal(local.targetInstanceId, "instance_local");
    assert.equal(fixture.service.list().length, 1);
  } finally { await fixture.close(); }
});

test("Changing the target instance keeps the previous definition when the folder cannot resolve", async () => {
  const fixture = await createFixture();
  try {
    const docker = fixture.service.create(input());
    const hosted = fixture.service.create(input({ targetInstanceId: "instance_local", cwdFolderId: "folder_free" }));

    assert.throws(
      () => fixture.service.update(hosted.id, { expectedRevision: hosted.revision, targetInstanceId: docker.targetInstanceId } as never),
      (error: any) => error.code === "AGENT_DEFINITION_FOLDER_UNKNOWN" && error.statusCode === 409,
    );
    // 被拒绝的编辑保留原定义，不写入任何一部分变更。
    assert.deepEqual(fixture.service.get(hosted.id), hosted);
  } finally { await fixture.close(); }
});

test("AgentOrchestration rejects unknown members, self edges and cycles while keeping dangling members", async () => {
  const fixture = await createFixture();
  try {
    const a = fixture.service.create(input({ name: "A" }));
    const b = fixture.service.create(input({ name: "B" }));
    const c = fixture.service.create(input({ name: "C" }));

    const chain = fixture.orchestrations.create({ name: "Chain", agentIds: [a.id, b.id, c.id], edges: [{ fromAgentId: a.id, toAgentId: b.id }, { fromAgentId: b.id, toAgentId: c.id }] });

    assert.throws(
      () => fixture.orchestrations.update(chain.id, { expectedRevision: chain.revision, edges: [...chain.edges, { fromAgentId: c.id, toAgentId: a.id }] }),
      (error: any) => {
        assert.equal(error.code, "AGENT_ORCHESTRATION_CYCLE");
        assert.deepEqual(canonicalCycle(error.details.cycle), canonicalCycle([a.id, b.id, c.id, a.id]));
        return true;
      },
    );
    assert.throws(
      () => fixture.orchestrations.update(chain.id, { expectedRevision: chain.revision, edges: [{ fromAgentId: a.id, toAgentId: a.id }] }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_INVALID_GRAPH",
    );
    assert.throws(
      () => fixture.orchestrations.create({ name: "Broken", agentIds: ["agent_missing"], edges: [] }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_AGENT_UNKNOWN",
    );
    assert.throws(
      () => fixture.orchestrations.create({ name: "No owner", agentIds: [a.id], edges: [{ fromAgentId: a.id, toAgentId: "agent_missing" }] }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_INVALID_GRAPH",
    );

    // 删除成员后编排保留悬挂引用：既有节点允许暂时未知，用户可显式移除。
    assert.equal(fixture.service.delete(b.id).deletedOrchestrationIds.length, 1);
    const dangling = fixture.orchestrations.get(chain.id);
    assert.deepEqual([...dangling.agentIds].sort(), [a.id, b.id, c.id].sort());
    assert.throws(
      () => fixture.orchestrations.update(chain.id, { expectedRevision: dangling.revision, agentIds: [a.id, c.id] }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_INVALID_GRAPH",
    );
    const repaired = fixture.orchestrations.update(chain.id, { expectedRevision: dangling.revision, agentIds: [a.id, c.id], edges: [] });
    assert.deepEqual([...repaired.agentIds].sort(), [a.id, c.id].sort());
    assert.deepEqual(repaired.edges, []);
  } finally { await fixture.close(); }
});

test("The default orchestration is editable, not deletable and must keep its owning agent", async () => {
  const fixture = await createFixture();
  try {
    const owner = fixture.service.create(input({ name: "Owner" }));
    const other = fixture.service.create(input({ name: "Other" }));
    const orchestration = defaultOrchestration(fixture, owner.id);

    const renamed = fixture.orchestrations.update(orchestration.id, {
      expectedRevision: orchestration.revision,
      name: "Owner chain",
      agentIds: [owner.id, other.id],
      edges: [{ fromAgentId: owner.id, toAgentId: other.id }],
    });
    assert.equal(renamed.name, "Owner chain");
    assert.deepEqual([...renamed.agentIds].sort(), [owner.id, other.id].sort());
    assert.equal(fixture.orchestrations.get(orchestration.id).revision, renamed.revision);

    assert.throws(
      () => fixture.orchestrations.update(orchestration.id, { expectedRevision: renamed.revision, agentIds: [other.id], edges: [] }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_DEFAULT_PROTECTED",
    );
    assert.throws(
      () => fixture.orchestrations.delete(orchestration.id),
      (error: any) => error.code === "AGENT_ORCHESTRATION_DEFAULT_PROTECTED" && error.statusCode === 409,
    );

    assert.throws(
      () => fixture.orchestrations.update(orchestration.id, { expectedRevision: orchestration.revision, name: "Stale" }),
      (error: any) => error.code === "AGENT_ORCHESTRATION_REVISION_CONFLICT"
        && error.details.expectedRevision === orchestration.revision
        && error.details.actualRevision === renamed.revision,
    );
  } finally { await fixture.close(); }
});

test("Deleting an Agent keeps custom orchestrations by default and can delete them on request", async () => {
  const fixture = await createFixture();
  try {
    const owner = fixture.service.create(input({ name: "Owner" }));
    const other = fixture.service.create(input({ name: "Other" }));
    const referencing = fixture.orchestrations.create({ name: "References owner", agentIds: [owner.id, other.id], edges: [{ fromAgentId: owner.id, toAgentId: other.id }] });

    const kept = fixture.service.delete(owner.id, { referencingOrchestrations: "keep" });
    assert.deepEqual(kept.deletedOrchestrationIds, [defaultAgentOrchestrationId(owner.id)]);
    assert.equal(fixture.orchestrations.has(referencing.id), true);
    assert.deepEqual([...fixture.orchestrations.get(referencing.id).agentIds].sort(), [owner.id, other.id].sort());

    const recreated = fixture.service.create(input({ name: "Owner again" }));
    const second = fixture.orchestrations.create({ name: "Second reference", agentIds: [recreated.id], edges: [] });
    const deleted = fixture.service.delete(recreated.id, { referencingOrchestrations: "delete" });
    assert.deepEqual([...deleted.deletedOrchestrationIds].sort(), [defaultAgentOrchestrationId(recreated.id), second.id].sort());
    assert.equal(fixture.orchestrations.has(second.id), false);
    // 其它 Agent 的默认编排永远不参与批量删除。
    assert.equal(fixture.orchestrations.has(defaultAgentOrchestrationId(other.id)), true);
  } finally { await fixture.close(); }
});

test("Agent definition and orchestration survive a restart and roll back together", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-agent-relations-restart-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const firstDatabase = await openNodeAgentDatabase(paths);
    const firstRepository = createNodeAgentRepository(firstDatabase);
    const firstOrchestrations = new AgentOrchestrationService(firstRepository.agents.orchestrations, firstRepository.agents.definitions);
    const firstService = new AgentDefinitionService(createState() as never, firstRepository.agents.definitions, firstOrchestrations);
    const target = firstService.create(input({ name: "Target" }));
    const chain = firstOrchestrations.create({ name: "Chain", agentIds: [target.id], edges: [] });
    await firstRepository.close();

    const secondDatabase = await openNodeAgentDatabase(paths);
    const secondRepository = createNodeAgentRepository(secondDatabase);
    const secondOrchestrations = new AgentOrchestrationService(secondRepository.agents.orchestrations, secondRepository.agents.definitions);
    const secondService = new AgentDefinitionService(createState() as never, secondRepository.agents.definitions, secondOrchestrations);
    assert.deepEqual(secondService.get(target.id), target);
    assert.equal(secondOrchestrations.get(chain.id).revision, chain.revision);
    assert.deepEqual(defaultOrchestration({ orchestrations: secondOrchestrations } as never, target.id).agentIds, [target.id]);

    assert.throws(() => secondRepository.agents.definitions.transaction(() => {
      secondOrchestrations.update(chain.id, { expectedRevision: chain.revision, name: "Rolled back" });
      throw new Error("rollback orchestration");
    }), /rollback orchestration/);
    assert.equal(secondOrchestrations.get(chain.id).name, chain.name);
    await secondRepository.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("Node Agent Agent API exposes CRUD with structured errors and change events", async () => {
  const fixture = await createFixture();
  try {
    const second = fixture.service.create(input({ name: "Second" }));
    const created = await fixture.app.inject({ method: "POST", url: "/api/node-agent/agents", payload: input() });
    assert.equal(created.statusCode, 201);
    const definition = created.json().data;
    assert.equal(definition.ownerNodeId, undefined);

    const orchestration = await fixture.app.inject({ method: "GET", url: `/api/node-agent/agent-orchestrations/${encodeURIComponent(defaultAgentOrchestrationId(definition.id))}` });
    assert.equal(orchestration.statusCode, 200);
    assert.deepEqual(orchestration.json().data.agentIds, [definition.id]);

    const list = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agents" });
    assert.deepEqual(list.json().data.agents.map((agent: { id: string }) => agent.id), [definition.id, second.id]);

    const orchestrationList = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agent-orchestrations" });
    assert.deepEqual(orchestrationList.json().data.orchestrations.map((item: { id: string }) => item.id).sort(), [
      defaultAgentOrchestrationId(definition.id),
      defaultAgentOrchestrationId(second.id),
    ].sort());

    const patchedChain = await fixture.app.inject({
      method: "PATCH",
      url: `/api/node-agent/agent-orchestrations/${encodeURIComponent(defaultAgentOrchestrationId(definition.id))}`,
      payload: {
        expectedRevision: orchestration.json().data.revision,
        agentIds: [definition.id, second.id],
        edges: [{ fromAgentId: definition.id, toAgentId: second.id }],
      },
    });
    assert.equal(patchedChain.statusCode, 200);
    assert.deepEqual([...patchedChain.json().data.agentIds].sort(), [definition.id, second.id].sort());

    const patched = await fixture.app.inject({
      method: "PATCH",
      url: `/api/node-agent/agents/${definition.id}`,
      payload: { expectedRevision: definition.revision, appendedPrompt: null, modelName: "gpt-5" },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().data.appendedPrompt, "");
    assert.equal(patched.json().data.modelName, "gpt-5");

    const conflict = await fixture.app.inject({
      method: "PATCH",
      url: `/api/node-agent/agents/${definition.id}`,
      payload: { expectedRevision: definition.revision, name: "Stale" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "AGENT_DEFINITION_REVISION_CONFLICT");
    assert.equal(conflict.json().error.details.actualRevision, patched.json().data.revision);

    const unknown = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agents/agent_missing" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, "AGENT_DEFINITION_NOT_FOUND");

    // 默认编排受保护：只能随所属 Agent 删除。
    const protectedDelete = await fixture.app.inject({
      method: "DELETE",
      url: `/api/node-agent/agent-orchestrations/${encodeURIComponent(defaultAgentOrchestrationId(definition.id))}`,
    });
    assert.equal(protectedDelete.statusCode, 409);
    assert.equal(protectedDelete.json().error.code, "AGENT_ORCHESTRATION_DEFAULT_PROTECTED");

    const removed = await fixture.app.inject({ method: "DELETE", url: `/api/node-agent/agents/${definition.id}` });
    assert.deepEqual(removed.json().data, { id: definition.id, deleted: true, deletedOrchestrationIds: [defaultAgentOrchestrationId(definition.id)] });

    assert.deepEqual(fixture.events.map((event) => [event.type, event.payload.change]), [
      ["agent.definition.changed", "created"],
      ["agent.orchestration.changed", "created"],
      ["agent.definition.changed", "created"],
      ["agent.orchestration.changed", "created"],
      ["agent.orchestration.changed", "updated"],
      ["agent.definition.changed", "updated"],
      ["agent.definition.changed", "deleted"],
      ["agent.orchestration.changed", "deleted"],
    ]);
    // 删除事件带修订号，Control Plane 据此收敛投影而不是依赖本地覆盖层。
    assert.deepEqual(fixture.events.at(-1)?.payload.orchestrationId, defaultAgentOrchestrationId(definition.id));
    assert.equal(fixture.events.at(-1)?.payload.nodeId, undefined);
  } finally { await fixture.close(); }
});

test("N-1 Node Agents without the agentExecution capability stay unsupported", () => {
  const legacy = normalizeNodeAgentCapabilities({ stories: { enabled: true } });
  assert.equal(legacy.agentExecution.definitions, false);
  assert.equal(legacy.agentExecution.runs, false);
  assert.equal(legacy.agentExecution.orchestration.orchestrations, false);
  const target = { runtime: "docker", providerId: "codex" };
  assert.equal(supportsNodeAgentExecutionPolicy(undefined, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, target), false);
  assert.equal(supportsNodeAgentExecutionPolicy({ agentExecution: { definitions: true, combinations: [{ runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" }] } }, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, target), true);
  // 未知字段被忽略而不是让整条记录失败。
  const parsed = sanitizeAgentDefinition({
    id: "agent_1",
    revision: "a".repeat(64),
    name: "Agent",
    targetInstanceId: "instance_1",
    cwdFolderId: "folder_1",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", future: true },
    createdAt: timestamp,
    updatedAt: timestamp,
    futureField: "ignored",
  });
  assert.deepEqual(parsed.executionPolicy, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" });
});

test("AgentDefinition survives a restart, tolerates unknown stored fields and rolls back failed writes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-agent-restart-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const firstDatabase = await openNodeAgentDatabase(paths);
    const firstRepository = createNodeAgentRepository(firstDatabase);
    const firstOrchestrations = new AgentOrchestrationService(firstRepository.agents.orchestrations, firstRepository.agents.definitions);
    const firstService = new AgentDefinitionService(createState() as never, firstRepository.agents.definitions, firstOrchestrations);
    const created = firstService.create(input());
    // 定义写入必须参与外层事务：外层回滚时不能留下任何已提交行。
    assert.throws(() => firstRepository.agents.definitions.transaction(() => {
      firstService.create(input({ name: "Rolled back" }));
      throw new Error("boom");
    }), /boom/);
    assert.equal(firstRepository.agents.definitions.list().length, 1);
    assert.equal(firstRepository.agents.orchestrations.list().length, 1);
    await firstRepository.close();

    const secondDatabase = await openNodeAgentDatabase(paths);
    const secondRepository = createNodeAgentRepository(secondDatabase);
    assert.deepEqual(secondRepository.agents.definitions.get(created.id), created);
    assert.deepEqual(secondRepository.agents.definitions.list().map((agent) => agent.id), [created.id]);

    // 未知字段在读取边界被忽略，已知数据仍然有效。
    secondDatabase.client.prepare("UPDATE na_agent_definitions SET execution_policy_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...created.executionPolicy, futureConstraint: true }), created.id);
    assert.equal(secondRepository.agents.definitions.get(created.id)?.executionPolicy.workspaceMaterializer, "overlay-copy-on-write");

    // 历史行在新增的可选列上是 NULL 时，按当前模型归一为「未设置」而不是空字符串。
    secondDatabase.client.prepare("UPDATE na_agent_definitions SET model_name = NULL, reasoning_effort = NULL WHERE id = ?").run(created.id);
    const historical = secondRepository.agents.definitions.get(created.id);
    assert.deepEqual([historical?.modelName, historical?.reasoningEffort, historical?.description], [undefined, undefined, ""]);

    // 更高版本写入的新列只产生诊断，不阻断读取。
    const diagnostics: Array<{ message: string; details: Record<string, unknown> }> = [];
    secondRepository.agents.definitions.setDiagnostic((message, details) => diagnostics.push({ message, details }));
    secondDatabase.client.exec("ALTER TABLE na_agent_definitions ADD COLUMN future_constraint TEXT");
    assert.equal(secondRepository.agents.definitions.get(created.id)?.id, created.id);
    assert.deepEqual(diagnostics.map(({ details }) => details.columns), [["future_constraint"]]);
    await secondRepository.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("AgentDefinition stored execution policies fail closed when their semantics are unknown", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-policy-fail-closed-");
  try {
    const orchestrations = new AgentOrchestrationService(fixture.repository.agents.orchestrations, fixture.repository.agents.definitions);
    const service = new AgentDefinitionService(createState() as never, fixture.repository.agents.definitions, orchestrations);
    const created = service.create(input());
    fixture.database.client.prepare("UPDATE na_agent_definitions SET execution_policy_json = ? WHERE id = ?")
      .run(JSON.stringify({ workspaceMaterializer: "future-materializer", processSandbox: "instance" }), created.id);

    assert.throws(
      () => fixture.repository.agents.definitions.get(created.id),
      (error: any) => error?.code === "NODE_AGENT_AGENT_DEFINITION_INVALID"
        && error?.statusCode === 500
        && error?.cause?.name === "ZodError",
    );
  } finally { await fixture.close(); }
});
