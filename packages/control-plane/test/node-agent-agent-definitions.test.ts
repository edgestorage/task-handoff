import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";
import { AgentDefinitionService, findCallableCycle } from "../src/node-agent/agents/service.ts";
import { registerNodeAgentDefinitionRoutes } from "../src/node-agent/agents/routes.ts";
import { agentDefinitionRevision } from "../src/node-agent/persistence/agent-repository.ts";
import { normalizeNodeAgentCapabilities, supportsNodeAgentExecutionPolicy } from "@task-handoff/protocol/node-agent-capabilities";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { openNodeAgentDatabase } from "../src/node-agent/persistence/database.ts";
import { createNodeAgentRepository } from "../src/node-agent/persistence/repository.ts";
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
  const service = new AgentDefinitionService(
    createState() as never,
    database.repository.agents.definitions,
    (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
  );
  const app = Fastify();
  registerNodeAgentDefinitionRoutes(app, service);
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 500).send({ error: { code: record.code ?? "NODE_AGENT_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) } });
  });
  return {
    ...database,
    service,
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
  const { name, description, appendedPrompt, targetInstanceId, cwdFolderId, providerId, modelEntityId, modelName, reasoningEffort, permissionMode, executionPolicy, callableAgentIds } = definition;
  return agentDefinitionRevision({ name, description, appendedPrompt, targetInstanceId, cwdFolderId, providerId, modelEntityId, modelName, reasoningEffort, permissionMode, executionPolicy, callableAgentIds });
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

test("AgentDefinition repository derives revision from content and rejects stale writes", async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.service.create(input());
    assert.match(created.id, /^agent_[0-9a-f]{20}$/);
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

test("AgentDefinition callable relations reject unknown, self and cyclic references", async () => {
  const fixture = await createFixture();
  try {
    const a = fixture.service.create(input({ name: "A" }));
    const b = fixture.service.create(input({ name: "B", callableAgentIds: [a.id] }));
    const c = fixture.service.create(input({ name: "C", callableAgentIds: [b.id] }));

    const invocation = fixture.service.resolveInvocationTools(c.id);
    assert.deepEqual(invocation.enabledTools, ["agent_run"]);
    assert.deepEqual(invocation.allowedAgentIds, [b.id]);

    assert.throws(
      () => fixture.service.update(a.id, { expectedRevision: a.revision, callableAgentIds: [c.id] } as never),
      (error: any) => {
        assert.equal(error.code, "AGENT_DEFINITION_CYCLE");
        assert.deepEqual(error.details.cycle, [a.id, c.id, b.id, a.id]);
        return true;
      },
    );
    assert.throws(
      () => fixture.service.update(a.id, { expectedRevision: a.revision, callableAgentIds: [a.id] } as never),
      (error: any) => error.code === "AGENT_DEFINITION_SELF_REFERENCE",
    );
    assert.throws(
      () => fixture.service.create(input({ name: "D", callableAgentIds: ["agent_missing"] })),
      (error: any) => error.code === "AGENT_DEFINITION_CALLABLE_TARGET_UNKNOWN",
    );
    // 被拒绝的写入不改变权威关系。
    assert.deepEqual(fixture.service.get(a.id).callableAgentIds, []);
    assert.deepEqual(fixture.service.get(c.id).callableAgentIds, [b.id]);

    // 删除 B 后保留 C 的稳定悬挂引用，读取方可以确定性投影修复诊断。
    assert.equal(fixture.service.delete(b.id), true);
    const dangling = fixture.service.get(c.id);
    assert.deepEqual(dangling.callableAgentIds, [b.id]);
    assert.equal(dangling.revision, c.revision);
    const afterDelete = fixture.service.resolveInvocationTools(c.id);
    assert.deepEqual(afterDelete.enabledTools, []);
    assert.deepEqual(afterDelete.allowedAgentIds, []);
    assert.notEqual(afterDelete.revision, invocation.revision);
    assert.throws(() => fixture.service.get(b.id), (error: any) => error.code === "AGENT_DEFINITION_NOT_FOUND" && error.statusCode === 404);
    assert.throws(() => fixture.service.delete(b.id), (error: any) => error.code === "AGENT_DEFINITION_NOT_FOUND" && error.statusCode === 404);
  } finally { await fixture.close(); }
});

test("AgentDefinition cycle detection reports the full path", () => {
  const edges = new Map<string, string[]>([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
  assert.deepEqual(findCallableCycle(edges, "a"), ["a", "b", "c", "a"]);
  assert.equal(findCallableCycle(new Map([["a", ["b"]], ["b", []]]), "a"), undefined);
});

test("Callable relation writes detect cycles against the latest authoritative graph", async () => {
  const fixture = await createFixture();
  try {
    const a = fixture.service.create(input({ name: "Concurrent A" }));
    const b = fixture.service.create(input({ name: "Concurrent B" }));

    const updatedA = fixture.service.update(a.id, { expectedRevision: a.revision, callableAgentIds: [b.id] } as never);
    assert.deepEqual(updatedA.callableAgentIds, [b.id]);
    assert.throws(
      () => fixture.service.update(b.id, { expectedRevision: b.revision, callableAgentIds: [a.id] } as never),
      (error: any) => error.code === "AGENT_DEFINITION_CYCLE"
        && error.details.cycle[0] === b.id
        && error.details.cycle.at(-1) === b.id,
    );
    assert.deepEqual(fixture.service.get(b.id).callableAgentIds, []);
  } finally { await fixture.close(); }
});

test("Callable relations survive restart and roll back with their definition update", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-agent-relations-restart-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const firstDatabase = await openNodeAgentDatabase(paths);
    const firstRepository = createNodeAgentRepository(firstDatabase);
    const firstService = new AgentDefinitionService(createState() as never, firstRepository.agents.definitions);
    const target = firstService.create(input({ name: "Target" }));
    const caller = firstService.create(input({ name: "Caller", callableAgentIds: [target.id] }));
    await firstRepository.close();

    const secondDatabase = await openNodeAgentDatabase(paths);
    const secondRepository = createNodeAgentRepository(secondDatabase);
    const secondService = new AgentDefinitionService(createState() as never, secondRepository.agents.definitions);
    assert.deepEqual(secondService.get(caller.id).callableAgentIds, [target.id]);

    assert.throws(() => secondRepository.agents.definitions.transaction(() => {
      secondService.update(caller.id, { expectedRevision: caller.revision, callableAgentIds: [] } as never);
      throw new Error("rollback relation");
    }), /rollback relation/);
    assert.deepEqual(secondService.get(caller.id).callableAgentIds, [target.id]);
    assert.equal(secondService.get(caller.id).revision, caller.revision);
    await secondRepository.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("Node Agent Agent API exposes CRUD with structured errors and change events", async () => {
  const fixture = await createFixture();
  try {
    const callable = fixture.service.create(input({ name: "Second" }));
    const created = await fixture.app.inject({ method: "POST", url: "/api/node-agent/agents", payload: input({ callableAgentIds: [callable.id] }) });
    assert.equal(created.statusCode, 201);
    const definition = created.json().data;
    assert.equal(definition.ownerNodeId, undefined);
    assert.deepEqual(definition.callableAgentIds, [callable.id]);

    const invocation = await fixture.app.inject({
      method: "GET",
      url: `/api/node-agent/agents/${definition.id}/invocation-tools`,
    });
    assert.equal(invocation.statusCode, 200);
    assert.deepEqual(invocation.json().data.allowedAgentIds, [callable.id]);
    assert.deepEqual(invocation.json().data.enabledTools, ["agent_run"]);

    const list = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agents" });
    assert.deepEqual(list.json().data.agents.map((agent: { id: string }) => agent.id), [definition.id, callable.id]);

    const patched = await fixture.app.inject({
      method: "PATCH",
      url: `/api/node-agent/agents/${definition.id}`,
      payload: { expectedRevision: definition.revision, appendedPrompt: null, modelName: "gpt-5" },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().data.appendedPrompt, "");
    assert.equal(patched.json().data.modelName, "gpt-5");
    // 补丁语义：未提交的字段保持权威值，不能被缺省值清空。
    assert.deepEqual(patched.json().data.callableAgentIds, [callable.id]);

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

    const selfReference = await fixture.app.inject({
      method: "PATCH",
      url: `/api/node-agent/agents/${definition.id}`,
      payload: { expectedRevision: patched.json().data.revision, callableAgentIds: [definition.id] },
    });
    assert.equal(selfReference.statusCode, 409);
    assert.equal(selfReference.json().error.code, "AGENT_DEFINITION_SELF_REFERENCE");

    const removed = await fixture.app.inject({ method: "DELETE", url: `/api/node-agent/agents/${definition.id}` });
    assert.deepEqual(removed.json().data, { id: definition.id, deleted: true });

    assert.deepEqual(fixture.events.map((event) => [event.type, event.payload.change]), [
      ["agent.definition.changed", "created"],
      ["agent.definition.changed", "created"],
      ["agent.definition.changed", "updated"],
      ["agent.definition.changed", "deleted"],
    ]);
    // 删除事件带修订号，Control Plane 据此收敛投影而不是依赖本地覆盖层。
    assert.deepEqual(fixture.events.at(-1)?.payload.revision, patched.json().data.revision);
    assert.equal(fixture.events.at(-1)?.payload.nodeId, undefined);
  } finally { await fixture.close(); }
});

test("N-1 Node Agents without the agentExecution capability stay unsupported", () => {
  const legacy = normalizeNodeAgentCapabilities({ stories: { enabled: true } });
  assert.equal(legacy.agentExecution.definitions, false);
  assert.equal(legacy.agentExecution.runs, false);
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
    const firstService = new AgentDefinitionService(createState() as never, firstRepository.agents.definitions);
    const created = firstService.create(input());
    // 定义写入必须参与外层事务：外层回滚时不能留下任何已提交行。
    assert.throws(() => firstRepository.agents.definitions.transaction(() => {
      firstService.create(input({ name: "Rolled back" }));
      throw new Error("boom");
    }), /boom/);
    assert.equal(firstRepository.agents.definitions.list().length, 1);
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
    const service = new AgentDefinitionService(createState() as never, fixture.repository.agents.definitions);
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
