import assert from "node:assert/strict";
import test from "node:test";
import { ControlledInstanceCreator } from "../src/control-plane/instances/creator.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

function fixture(retention, deployedStatus = "deferred") {
  const calls = [];
  const createdInputs = [];
  const payload = {
    credential: {
      id: "gitcred_one",
      name: "Team token",
      kind: "https-token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/" },
      secretSet: true,
      status: "enabled",
      revision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    secret: { kind: "https-token", username: "git", token: "creation-secret" },
  };
  const instance = {
    id: "inst_one",
    registrationToken: "registration-token",
    connectionStatus: "offline",
    agentStatus: "offline",
  };
  const repository = {
    id: "repo_one",
    name: "Team repository",
    source: {
      type: "git-repository",
      repositoryId: "repo_one",
      url: "https://git.example.com/team/repo.git",
      ref: { type: "branch", name: "main" },
      auth: { type: "https-token", secretId: "gitcred_one" },
      clone: { submodules: false, lfs: false, subdirectory: "" },
    },
    workspacePolicy: { mode: "git-clone", path: "/workspace", readOnly: false },
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const gitCredentials = {
    payload: (credentialId) => {
      if (credentialId !== payload.credential.id) throw Object.assign(new Error("missing"), { code: "GIT_CREDENTIAL_NOT_FOUND" });
      return payload;
    },
    authorize: (instanceId, credentialId) => {
      calls.push("authorize");
      return {
        instanceId,
        credentialId,
        credentialRevision: 3,
        assignmentRevision: 1,
        status: "pending",
        authorizedAt: timestamp,
        updatedAt: timestamp,
      };
    },
    markAssignmentStatus: (_instanceId, _credentialId, status) => { calls.push(`status:${status}`); },
    desiredAuthorizationSet: (instanceId) => ({ instanceId, generation: 1, credentialIds: [payload.credential.id], updatedAt: timestamp }),
    revoke: () => { calls.push("revoke"); },
    rememberOperationProvisioning: () => { calls.push("remember-provisioning"); },
    forgetOperationProvisioning: () => { calls.push("forget-provisioning"); },
  };
  const gateway = {
    createInstance: async (_node, input) => { calls.push("create"); createdInputs.push(input); return instance; },
    deployGitCredential: async () => { calls.push("payload"); },
    removeGitCredential: async () => { calls.push("remove-payload"); },
    replaceGitCredentialAuthorizations: async () => { calls.push("authorizations"); },
    assignInstanceModels: async () => { calls.push("models"); return { instance }; },
    startInstance: async (_node, _instanceId, input) => {
      calls.push("start");
      createdInputs.push(input);
      return { instance, gitWorkspaceProvisioningOperationId: input.gitWorkspaceProvisioning?.operationId };
    },
    deleteInstance: async () => ({ completed: true }),
    listInstances: async () => [],
  };
  const creator = new ControlledInstanceCreator({
    gateway,
    defaultNodeId: () => "node_one",
    requireProject: (id) => {
      if (id !== repository.id) throw new Error("missing repository");
      return repository;
    },
    requireNode: () => ({
      id: "node_one",
      capabilities: {
        agent: {
          capabilities: {
            managedGitCredentials: {
              registry: true,
              runtimeBroker: true,
              workspaceProvisioning: { docker: true, kubernetes: false, local: false },
            },
          },
        },
      },
    }),
    requireRuntime: async () => ({ id: "runtime_one", name: "Docker", type: "docker", capabilities: { requiresImage: false } }),
    requireLocalFolder: async () => { throw new Error("not used"); },
    resolveImageSelection: () => { throw new Error("not used"); },
    prepareModels: async () => ({}),
    gitCredentials,
  });
  const run = (overrides = {}) => creator.create({
    id: "inst_one",
    nodeId: "node_one",
    runtimeId: "runtime_one",
    projectId: repository.id,
    gitCredentialRetention: retention,
    start: false,
    ...overrides,
  });
  return { calls, createdInputs, repository, instance, gateway, run };
}

test("Repository credential defaults to one operation-only provisioning grant without an assignment", async () => {
  const state = fixture(undefined);
  await state.run();
  assert.equal(state.createdInputs[0].gitWorkspaceProvisioning.credentials[0].retention, "operation-only");
  assert.deepEqual(state.createdInputs[0].source.auth, { type: "none" });
  assert.deepEqual(state.createdInputs[0].sourceSnapshot.source.auth, { type: "none" });
  assert.deepEqual(state.calls, ["remember-provisioning", "create", "models"]);
});

test("operation-only provisioning is reissued on immediate start", async () => {
  const state = fixture("operation-only");
  await state.run({ start: true });
  assert.equal(state.createdInputs[1].gitWorkspaceProvisioning.credentials[0].payload.secret.token, "creation-secret");
  assert.deepEqual(state.calls, ["remember-provisioning", "create", "models", "start", "forget-provisioning"]);
});

test("invalid historical Repository credential reference fails without a client override", async () => {
  const state = fixture("operation-only");
  state.repository.source.auth.secretId = "legacy_secret";
  await assert.rejects(() => state.run(), (error) => error.code === "GIT_CREDENTIAL_NOT_FOUND");
  assert.deepEqual(state.calls, []);
});

test("retained creation deploys payload after instance confirmation and before the atomic authorization set", async () => {
  const state = fixture("instance-retained", "deferred");
  await state.run();
  assert.equal(state.createdInputs[0].gitWorkspaceProvisioning, undefined);
  assert.deepEqual(state.calls, ["create", "payload", "authorize", "authorizations", "status:synced", "models"]);
});

test("retained immediate start resolves from the authorization set instead of reissuing a secret snapshot", async () => {
  const state = fixture("instance-retained");
  await state.run({ start: true });
  assert.deepEqual(state.createdInputs[1], {});
  assert.equal(state.calls.includes("forget-provisioning"), false);
});

test("an ambiguous create response reconciles the caller-assigned instance id", async () => {
  const state = fixture("operation-only");
  state.gateway.createInstance = async () => { state.calls.push("create:response-lost"); throw new Error("response lost"); };
  state.gateway.listInstances = async () => { state.calls.push("list"); return [state.instance]; };
  const result = await state.run();
  assert.equal(result.id, state.instance.id);
  assert.deepEqual(state.calls, ["remember-provisioning", "create:response-lost", "list", "models"]);
});

test("uncertain create compensation is reported and preserves the operation intent", async () => {
  const state = fixture("operation-only");
  state.gateway.createInstance = async () => { throw new Error("response lost"); };
  state.gateway.listInstances = async () => { throw new Error("node unavailable"); };
  state.gateway.deleteInstance = async () => ({ completed: false });
  await assert.rejects(
    () => state.run(),
    (error) => error.code === "INSTANCE_CREATE_COMPENSATION_REQUIRED",
  );
  assert.equal(state.calls.includes("forget-provisioning"), false);
});

test("a lost retained payload response still triggers payload cleanup", async () => {
  const state = fixture("instance-retained");
  state.gateway.deployGitCredential = async () => { state.calls.push("payload:response-lost"); throw new Error("response lost"); };
  await assert.rejects(() => state.run(), /response lost/);
  assert.deepEqual(state.calls, ["create", "payload:response-lost", "remove-payload"]);
});
