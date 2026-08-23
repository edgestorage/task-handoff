import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { NodeGitCredentialStore } from "../src/node-agent/git-credentials/store.ts";
import { registerNodeGitCredentialRoutes } from "../src/node-agent/git-credentials/routes.ts";
import { NodeAgentState } from "../src/node-agent/state.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

function payload(revision = 1) {
  return {
    credential: {
      id: "gitcred_one", name: "Team token", kind: "https-token" as const,
      scope: { scheme: "https" as const, host: "git.example.com", pathPrefix: "/team/" },
      secretSet: true as const, status: "enabled" as const, revision, createdAt: timestamp, updatedAt: timestamp,
    },
    secret: { kind: "https-token" as const, username: "git", token: `secret-${revision}` },
  };
}

function authorization(generation: number, credentialIds = ["gitcred_one"]) {
  return { instanceId: "inst_one", generation, credentialIds, updatedAt: timestamp };
}

test("node stores one payload per credential and resolves only through an instance authorization set", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new NodeGitCredentialStore(paths);
    store.init();
    assert.throws(() => store.putAuthorizationSet(authorization(1)), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_PAYLOAD_MISSING");
    store.putPayload(payload());
    store.putAuthorizationSet(authorization(1));
    const selected = store.resolve("inst_one", "https://git.example.com/team/repo.git");
    assert.equal(selected.match.status, "unique");
    assert.equal(selected.payload?.secret.kind === "https-token" ? selected.payload.secret.token : "", "secret-1");
    assert.equal(store.resolve("inst_other", "https://git.example.com/team/repo.git").match.status, "none");

    const restored = new NodeGitCredentialStore(paths);
    restored.init();
    assert.deepEqual(restored.getAuthorizationSet("inst_one").credentialIds, ["gitcred_one"]);
    assert.equal(fs.statSync(paths.gitCredentialPayloadsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(paths.gitCredentialPayloadsDir, "gitcred_one.json")).mode & 0o777, 0o600);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("payload revision and authorization generation reject stale or conflicting delivery", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-revision-"));
  try {
    const store = new NodeGitCredentialStore(nodeAgentStorePaths(dataDir));
    store.init();
    store.putPayload(payload(2));
    assert.throws(() => store.putPayload(payload(1)), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_REVISION_STALE");
    store.putAuthorizationSet(authorization(4));
    assert.throws(() => store.putAuthorizationSet(authorization(3, [])), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_REVISION_STALE");
    assert.throws(() => store.putAuthorizationSet(authorization(4, [])), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_REVISION_CONFLICT");
    store.putAuthorizationSet(authorization(5, []));
    assert.equal(store.resolve("inst_one", "https://git.example.com/team/repo.git").match.status, "none");
    assert.equal(store.collectUnreferencedPayloads(), 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("pre-release per-credential assignments migrate to an atomic authorization set", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-migrate-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const bootstrap = new NodeGitCredentialStore(paths);
    bootstrap.init();
    bootstrap.putPayload(payload());
    fs.mkdirSync(paths.gitCredentialAssignmentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.gitCredentialAssignmentsDir, "inst_one:gitcred_one.json"), JSON.stringify({
      id: "inst_one:gitcred_one", instanceId: "inst_one", credentialId: "gitcred_one", credentialRevision: 1,
      assignmentRevision: 7, status: "synced", authorizedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    }));
    const store = new NodeGitCredentialStore(paths);
    store.init();
    assert.deepEqual(store.getAuthorizationSet("inst_one"), { instanceId: "inst_one", generation: 7, credentialIds: ["gitcred_one"], updatedAt: store.getAuthorizationSet("inst_one").updatedAt });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("node restart keeps shared authorization, rotation reaches every instance, and revoke garbage-collects last use", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-shared-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new NodeGitCredentialStore(paths);
    store.init();
    store.putPayload(payload());
    store.putAuthorizationSet(authorization(1));
    store.putAuthorizationSet({ ...authorization(1), instanceId: "inst_two" });

    const restored = new NodeGitCredentialStore(paths);
    restored.init();
    restored.putPayload(payload(2));
    for (const instanceId of ["inst_one", "inst_two"]) {
      const selected = restored.resolve(instanceId, "https://git.example.com/team/repo.git").payload;
      assert.equal(selected?.secret.kind === "https-token" ? selected.secret.token : "", "secret-2");
    }
    restored.putAuthorizationSet(authorization(2, []));
    assert.equal(restored.collectUnreferencedPayloads(), 0);
    restored.putAuthorizationSet({ ...authorization(2, []), instanceId: "inst_two" });
    assert.equal(restored.collectUnreferencedPayloads(), 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("runtime HTTPS broker authenticates the instance and returns the latest node payload", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-git-route-"));
  const state = new NodeAgentState(nodeAgentStorePaths(dataDir), "node_one", "http://127.0.0.1:8091", undefined, 8091, "linux");
  state.init();
  const instance = state.createInstance({
    id: "inst_one", runtimeId: "runtime_local_docker", imageSelection: { imageId: "img_one" },
    image: { id: "img_one", origin: "custom", name: "Image", repository: "image", tag: "latest", requestedReference: "image:latest", pullPolicy: "if-not-present", capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp },
    source: { type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/team/repo.git", ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { submodules: false, lfs: false, subdirectory: "" } },
    sourceSnapshot: {}, modelSelection: {},
  });
  state.gitCredentials.putPayload(payload());
  state.gitCredentials.putAuthorizationSet(authorization(1));
  const app = Fastify({ logger: false });
  registerNodeGitCredentialRoutes(app, state);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const denied = await app.inject({ method: "POST", url: "/api/node-agent/instances/inst_one/git-credentials/https", headers: { authorization: "Bearer wrong" }, payload: { remoteUrl: "https://git.example.com/team/repo.git" } });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({ method: "POST", url: "/api/node-agent/instances/inst_one/git-credentials/https", headers: { authorization: `Bearer ${instance.registrationToken}` }, payload: { remoteUrl: "https://git.example.com/team/repo.git" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { status: "ok", username: "git", password: "secret-1" });
});
