import assert from "node:assert/strict";
import test from "node:test";
import { canAccessResolvedResource } from "../src/control-plane/auth/authorization.ts";
import { resolveRequestResourceScopes } from "../src/control-plane/auth/resource-scope.ts";
import { projectFederatedModelRegistry } from "../src/control-plane/http/access-projection.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";

function serviceFixture() {
  const requiredNodes: string[] = [];
  const requiredInstances: string[] = [];
  const authorizationNodeScopes: Array<string[] | undefined> = [];
  const projects = new Map<string, any>([
    ["git", { id: "git", source: { type: "git" } }],
    ["local", { id: "local", source: { type: "local-folder", ownerNodeId: "node-a" } }],
    ["orphan", { id: "orphan", source: { type: "local-folder" } }],
  ]);
  const instances = new Map([
    ["instance-a", { id: "instance-a", nodeId: "node-a" }],
    ["instance-b", { id: "instance-b", nodeId: "node-b" }],
  ]);
  const service = {
    requireNode(nodeId: string) {
      requiredNodes.push(nodeId);
      if (!nodeId.startsWith("node-")) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { id: nodeId };
    },
    requireProject(projectId: string) {
      const project = projects.get(projectId);
      if (!project) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return project;
    },
    requireControlledInstanceForAuthorization(instanceId: string, allowedNodeIds?: ReadonlySet<string>) {
      requiredInstances.push(instanceId);
      authorizationNodeScopes.push(allowedNodeIds ? [...allowedNodeIds] : undefined);
      const instance = instances.get(instanceId);
      if (!instance || (allowedNodeIds && !allowedNodeIds.has(instance.nodeId))) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return instance;
    },
    resolveControlledInstanceTargetNodeId(input: { nodeId?: string }) {
      return input.nodeId || "node-b";
    },
  };
  return { service: service as any, requiredNodes, requiredInstances, authorizationNodeScopes };
}

function request(params: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return { params, body } as any;
}

test("resource scope distinguishes explicit global authorization boundaries", async () => {
  const { service } = serviceFixture();
  assert.deepEqual(await resolveRequestResourceScopes(service, request(), "/api/users", { type: "user" }), [{ kind: "global-admin" }]);
  assert.deepEqual(await resolveRequestResourceScopes(service, request(), "/api/triggers", { type: "trigger-template" }), [{ kind: "global-shared" }]);
  assert.deepEqual(await resolveRequestResourceScopes(service, request(), "/api/node-runtimes", { type: "public-directory" }), [{ kind: "global-public" }]);
});

test("node routes use authoritative route identity and ignore forged body nodeId", async () => {
  const { service, requiredNodes } = serviceFixture();
  const scopes = await resolveRequestResourceScopes(
    service,
    request({ id: "node-a", runtimeId: "runtime-a" }, { nodeId: "node-b" }),
    "/api/nodes/:id/runtimes/:runtimeId",
    { type: "runtime" },
  );
  assert.deepEqual(scopes, [{ kind: "node", nodeId: "node-a" }]);
  assert.deepEqual(requiredNodes, ["node-a"]);
});

test("instance-derived resources resolve their parent instance before authorization", async () => {
  const { service, requiredInstances, authorizationNodeScopes } = serviceFixture();
  const actor = { type: "user", userId: "user-a", identityId: "identity-a", roleIds: ["role_operator"], permissionIds: ["ai-sessions:manage"], nodeScope: { kind: "selected", nodeIds: ["node-a"] }, authorizationRevision: 1 } as const;
  const scopes = await resolveRequestResourceScopes(
    service,
    request({ id: "instance-a", sessionId: "session-a" }, { nodeId: "node-b" }),
    "/api/controlled-instances/:id/ai-sessions/:sessionId/messages",
    { type: "ai-session" },
    actor,
  );
  assert.deepEqual(scopes, [{ kind: "instance-derived", nodeId: "node-a", instanceId: "instance-a" }]);
  assert.deepEqual(requiredInstances, ["instance-a"]);
  assert.deepEqual(authorizationNodeScopes, [undefined]);
  const hiddenScopes = await resolveRequestResourceScopes(
    service,
    request({ id: "instance-b", sessionId: "session-b" }),
    "/api/controlled-instances/:id/ai-sessions/:sessionId/messages",
    { type: "ai-session" },
    actor,
  );
  assert.equal(canAccessResolvedResource(actor as any, "send-message", { type: "ai-session" }, hiddenScopes![0]), false);
  assert.equal(authorizationNodeScopes.at(-1), undefined);
});

test("selected instance scope is independent from node scope", async () => {
  const { service } = serviceFixture();
  const actor = {
    type: "user",
    userId: "user-a",
    identityId: "identity-a",
    roleIds: ["role_operator"],
    permissionIds: ["ai-sessions:read", "ai-sessions:manage"],
    nodeScope: { kind: "selected", nodeIds: ["node-a"] },
    instanceScope: { kind: "selected", instanceIds: ["instance-b"] },
    authorizationRevision: 1,
  } as const;
  const selected = await resolveRequestResourceScopes(service, request({ id: "instance-b" }), "/api/controlled-instances/:id/ai-sessions", { type: "ai-session" }, actor as any);
  const sameNodeUnselected = await resolveRequestResourceScopes(service, request({ id: "instance-a" }), "/api/controlled-instances/:id/ai-sessions", { type: "ai-session" }, actor as any);
  assert.equal(canAccessResolvedResource(actor as any, "read", { type: "ai-session" }, selected![0]), true);
  assert.equal(canAccessResolvedResource(actor as any, "read", { type: "ai-session" }, sameNodeUnselected![0]), false);
});

test("instance creation authorizes the resolved default node", async () => {
  const { service, requiredNodes } = serviceFixture();
  const scopes = await resolveRequestResourceScopes(service, request({}, {}), "/api/controlled-instances", { type: "instance" }, undefined, "create");
  assert.deepEqual(scopes, [{ kind: "node", nodeId: "node-b" }]);
  assert.deepEqual(requiredNodes, ["node-b"]);
  const actor = {
    type: "user", userId: "user-a", identityId: "identity-a", roleIds: ["role_operator"],
    permissionIds: ["instances:manage"], nodeScope: { kind: "selected", nodeIds: ["node-a"] },
    instanceScope: { kind: "selected", instanceIds: ["instance-b"] }, authorizationRevision: 1,
  } as const;
  assert.equal(canAccessResolvedResource(actor as any, "create", { type: "instance" }, scopes![0]), false);
});

test("Trigger apply resolves every unique target before the handler can execute", async () => {
  const { service, requiredInstances, authorizationNodeScopes } = serviceFixture();
  const actor = { type: "user", userId: "user-a", identityId: "identity-a", roleIds: ["role_operator"], permissionIds: ["triggers:manage"], nodeScope: { kind: "selected", nodeIds: ["node-a", "node-b"] }, authorizationRevision: 1 } as const;
  const scopes = await resolveRequestResourceScopes(
    service,
    request({ configHash: "trigger-a" }, { instanceIds: ["instance-a", "instance-b", "instance-a"], nodeId: "node-forged" }),
    "/api/triggers/:configHash/apply",
    { type: "trigger-deployment" },
    actor,
  );
  assert.deepEqual(scopes, [
    { kind: "instance-derived", nodeId: "node-a", instanceId: "instance-a" },
    { kind: "instance-derived", nodeId: "node-b", instanceId: "instance-b" },
  ]);
  assert.deepEqual(requiredInstances.sort(), ["instance-a", "instance-b"]);
  assert.deepEqual(authorizationNodeScopes, [undefined, undefined]);
});

test("Git projects are global while Local Folder projects fail closed without an owner", async () => {
  const { service } = serviceFixture();
  assert.deepEqual(await resolveRequestResourceScopes(service, request({ id: "git" }), "/api/projects/:id", { type: "project" }), [{ kind: "global-public" }]);
  assert.deepEqual(await resolveRequestResourceScopes(service, request({ id: "local" }), "/api/projects/:id", { type: "project" }), [{ kind: "node", nodeId: "node-a" }]);
  await assert.rejects(
    resolveRequestResourceScopes(service, request({ id: "orphan" }), "/api/projects/:id", { type: "project" }),
    (error: unknown) => (error as { code?: string; statusCode?: number }).code === "CONTROL_PLANE_RESOURCE_NOT_VISIBLE"
      && (error as { statusCode?: number }).statusCode === 404,
  );
});

test("federated model projection filters locations, diagnostics, groups, and derived counts", () => {
  const scopedRequest = {} as any;
  setControlPlaneRequestActor(scopedRequest, {
    type: "user",
    userId: "user-a",
    identityId: "identity-a",
    roleIds: ["role_viewer"],
    permissionIds: ["models:read"],
    nodeScope: { kind: "selected", nodeIds: ["node-a"] },
    authorizationRevision: 1,
  });
  const projected = projectFederatedModelRegistry(scopedRequest, {
    updatedAt: "2026-08-22T00:00:00.000Z",
    models: [
      {
        id: "shared",
        model: {} as any,
        locations: [
          { type: "control-plane", name: "Shared", enabled: true, order: 0 },
          { type: "node", nodeId: "node-a", name: "Shared A", enabled: true, order: 0, referenceCount: 2 },
          { type: "node", nodeId: "node-b", name: "Shared B", enabled: true, order: 0, referenceCount: 7 },
        ],
        referenceCount: 9,
      },
      {
        id: "hidden",
        model: {} as any,
        locations: [{ type: "node", nodeId: "node-b", name: "Hidden", enabled: true, order: 0, referenceCount: 11 }],
        referenceCount: 11,
      },
    ],
    nodeDiagnostics: [
      { nodeId: "node-a", code: "A", message: "visible" },
      { nodeId: "node-b", code: "B", message: "hidden" },
    ],
  });

  assert.deepEqual(projected.models.map((model) => ({
    id: model.id,
    nodeIds: model.locations.flatMap((location) => location.type === "node" ? [location.nodeId] : []),
    referenceCount: model.referenceCount,
  })), [{ id: "shared", nodeIds: ["node-a"], referenceCount: 2 }]);
  assert.deepEqual(projected.nodeDiagnostics.map((diagnostic) => diagnostic.nodeId), ["node-a"]);
});

test("authorization snapshot lookup never refreshes a node-agent directory", () => {
  let downstreamCalls = 0;
  let inspectedNodeIds: string[] = [];
  const service = Object.create(ControlPlaneService.prototype) as any;
  service.listNodes = () => [{ id: "node-a" }, { id: "node-b" }];
  service.nodeAgentGateway = {
    instanceFromSnapshot(nodes: Array<{ id: string }>) {
      inspectedNodeIds = nodes.map((node) => node.id);
      return undefined;
    },
    listFleetInstances() {
      downstreamCalls += 1;
      throw new Error("authorization must not refresh downstream topology");
    },
  };

  assert.throws(
    () => service.requireControlledInstanceForAuthorization("known-hidden-id", new Set(["node-a"])),
    (error: unknown) => (error as { code?: string }).code === "CONTROLLED_INSTANCE_NOT_FOUND",
  );
  assert.deepEqual(inspectedNodeIds, ["node-a"]);
  assert.equal(downstreamCalls, 0);
});

test("every resource family ignores forged node identity and follows its authoritative parent", async () => {
  const { service } = serviceFixture();
  const actor = { type: "user", userId: "user-a", identityId: "identity-a", roleIds: ["role_operator"], permissionIds: ["nodes:manage", "instances:manage"], nodeScope: { kind: "selected", nodeIds: ["node-a"] }, authorizationRevision: 1 } as const;
  for (const resource of ["node", "runtime", "template", "model"] as const) {
    assert.deepEqual(await resolveRequestResourceScopes(
      service,
      request({ nodeId: "node-a", id: "node-a" }, { nodeId: "node-b" }),
      "/api/nodes/:nodeId/resources/:id",
      { type: resource },
      actor,
    ), [{ kind: "node", nodeId: "node-a" }]);
  }
  for (const resource of ["instance", "app-session", "ai-session", "attachment", "trigger-deployment", "repository", "template"] as const) {
    assert.deepEqual(await resolveRequestResourceScopes(
      service,
      request({ id: "instance-a", childId: "known-child" }, { instanceId: "instance-b", nodeId: "node-b" }),
      "/api/controlled-instances/:id/resources/:childId",
      { type: resource },
      actor,
    ), [{ kind: "instance-derived", nodeId: "node-a", instanceId: "instance-a" }]);
  }
  for (const resource of ["image", "public-directory"] as const) {
    assert.deepEqual(await resolveRequestResourceScopes(service, request({}, { nodeId: "node-b" }), "/api/catalog", { type: resource }, actor), [{ kind: "global-public" }]);
  }
  assert.deepEqual(await resolveRequestResourceScopes(service, request({}, { nodeId: "node-b" }), "/api/triggers", { type: "trigger-template" }, actor), [{ kind: "global-shared" }]);
  assert.deepEqual(await resolveRequestResourceScopes(service, request({}, { nodeId: "node-b" }), "/api/users", { type: "user" }, actor), [{ kind: "global-admin" }]);
});
