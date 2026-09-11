import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { ControlPlaneGitCredentialService } from "../src/control-plane/git-credentials/service.ts";
import { ControlPlaneGitRepository } from "../src/control-plane/git-credentials/repository.ts";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { createControlPlaneApp } from "../src/control-plane/http/server.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-credentials-"));
  const paths = controlPlaneStorePaths(dataDir);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneGitRepository(database, secrets);
  const service = new ControlPlaneGitCredentialService(repository);
  await service.init();
  return { dataDir, paths, database, repository, service };
}

async function controlPlaneServiceFixture(dataDir: string) {
  const paths = controlPlaneStorePaths(dataDir);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const service = new ControlPlaneService(paths, { database, secrets });
  await service.init();
  return { database, service };
}

test("Git credential CRUD exposes only public projections and preserves secrets on metadata update", async () => {
  const { dataDir, paths, database, service } = await fixture();
  try {
    const created = await service.create({
      name: "Team token",
      scope: { scheme: "https", host: "Git.Example.com", port: 443, pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "secret-one" },
    });
    assert.equal(created.scope.host, "git.example.com");
    assert.equal(created.scope.port, undefined);
    assert.equal("token" in created, false);
    assert.equal(JSON.stringify(service.list()).includes("secret-one"), false);
    const initialPayload = await service.payload(created.id);
    assert.equal(initialPayload.secret.kind, "https-token");
    assert.equal(initialPayload.secret.kind === "https-token" ? initialPayload.secret.token : "", "secret-one");

    const updated = await service.update(created.id, { name: "Renamed" });
    assert.equal(updated.revision, 2);
    const preservedPayload = await service.payload(created.id);
    assert.equal(preservedPayload.secret.kind === "https-token" ? preservedPayload.secret.token : "", "secret-one");
    await service.update(created.id, { secret: { kind: "https-token", username: "git", token: "secret-two" } });
    const rotatedPayload = await service.payload(created.id);
    assert.equal(rotatedPayload.secret.kind === "https-token" ? rotatedPayload.secret.token : "", "secret-two");

    const persisted = JSON.stringify(await database.gitCredentials.get(created.id));
    assert.equal(persisted.includes("secret-one"), false);
    assert.equal(persisted.includes("secret-two"), false);
    assert.equal(fs.statSync(paths.databaseEncryptionKeyPath).mode & 0o777, 0o600);
  } finally {
    await database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("assignment lifecycle protects referenced credentials and uses monotonic revisions", async () => {
  const { dataDir, database, service } = await fixture();
  try {
    const credential = await service.create({
      name: "SSH",
      scope: { scheme: "ssh", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "ssh-key", privateKey: "private-key", passphrase: "passphrase", pinnedKnownHosts: "git.example.com ssh-ed25519 AAAA" },
    });
    const pending = await service.authorize("inst_one", credential.id);
    assert.equal(pending.status, "pending");
    const synced = await service.markAssignmentStatus("inst_one", credential.id, "synced");
    assert.equal(synced.assignmentRevision, pending.assignmentRevision + 1);
    await assert.rejects(() => service.remove(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_IN_USE");
    assert.equal(await service.revoke("inst_one", credential.id), true);
    const reauthorized = await service.authorize("inst_one", credential.id);
    assert.ok(reauthorized.assignmentRevision > synced.assignmentRevision);
    assert.equal(await service.revoke("inst_one", credential.id), true);
    assert.equal(await service.remove(credential.id), true);
    const audit = await database.gitAudit.list();
    const auditText = JSON.stringify(audit);
    assert.equal(auditText.includes("private-key"), false);
    assert.equal(auditText.includes("passphrase"), false);
    assert.equal(auditText.includes("git.example.com ssh-ed25519"), false);
    assert.ok(audit.some((entry) => entry.action === "authorize"));
    assert.ok(audit.some((entry) => entry.action === "revoke"));
    const revokeRevisions = audit
      .filter((entry) => entry.action === "revoke")
      .map((entry) => entry.assignmentRevision)
      .sort((left, right) => left - right);
    assert.deepEqual(revokeRevisions, [3, 5]);
  } finally {
    await database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("operation-only provisioning intent survives restart without persisting secret material", async () => {
  const { dataDir, database, repository, service } = await fixture();
  try {
    const credential = await service.create({
      name: "Token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "operation-secret" },
    });
    await service.rememberOperationProvisioning({
      operationId: "gitop_one",
      instanceId: "inst_one",
      remoteUrl: "https://git.example.com/team/repo.git",
      ref: { type: "branch", name: "main" },
      clone: { submodules: false, lfs: false, subdirectory: "packages/app" },
      credentials: [{ operationId: "gitcredop_one", retention: "operation-only", payload: await service.payload(credential.id) }],
    });
    const intentText = JSON.stringify(await database.gitProvisioningIntents.get("inst_one"));
    assert.equal(intentText.includes("operation-secret"), false);

    const restored = new ControlPlaneGitCredentialService(repository);
    await restored.init();
    const provisioning = await restored.operationProvisioning("inst_one");
    assert.equal(provisioning?.operationId, "gitop_one");
    assert.equal((await restored.operationProvisioning("inst_one"))?.operationId, "gitop_one");
    assert.equal(provisioning?.clone.subdirectory, "packages/app");
    assert.equal(provisioning?.credentials[0]?.payload.secret.kind === "https-token" ? provisioning.credentials[0].payload.secret.token : "", "operation-secret");
    await assert.rejects(() => restored.remove(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_IN_USE");
    await restored.forgetOperationProvisioning("inst_one");
    assert.equal(await restored.remove(credential.id), true);
  } finally {
    await database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deferred revocation is retried and releases the credential deletion guard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-revoke-retry-"));
  try {
    const { database, service } = await controlPlaneServiceFixture(dataDir);
    const credential = await service.gitCredentials.create({
      name: "Team token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "secret" },
    });
    await service.gitCredentials.authorize("inst_one", credential.id);
    await service.gitCredentials.markAssignmentStatus("inst_one", credential.id, "revoking");

    const internals = service as unknown as {
      requireControlledInstance: (instanceId: string, cached: boolean) => Promise<{ id: string; nodeId: string }>;
      requireNode: (nodeId: string) => { id: string };
      nodeAgentGateway: { replaceGitCredentialAuthorizations: () => Promise<void> };
    };
    internals.requireControlledInstance = async () => ({ id: "inst_one", nodeId: "node_one" });
    internals.requireNode = () => ({ id: "node_one" });
    let attempts = 0;
    internals.nodeAgentGateway.replaceGitCredentialAuthorizations = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("node unavailable");
    };

    await service.recoverPendingPairingRevokes();
    assert.equal(service.gitCredentials.listAssignments("inst_one")[0]?.status, "revoking");
    await assert.rejects(() => service.gitCredentials.remove(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_IN_USE");

    await service.recoverPendingPairingRevokes();
    assert.equal(attempts, 2);
    assert.deepEqual(service.gitCredentials.listAssignments("inst_one"), []);
    assert.equal(await service.gitCredentials.remove(credential.id), true);
    await database.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Git Repository owns its credential reference and protects it from deletion or incompatible scope changes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-repository-auth-"));
  try {
    const { database, service } = await controlPlaneServiceFixture(dataDir);
    const credential = await service.gitCredentials.create({
      name: "Team token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "secret" },
    });
    const project = service.createProject({
      name: "Team repository",
      source: {
        type: "git-repository",
        url: "https://git.example.com/team/repo.git",
        ref: { type: "branch", name: "main" },
        auth: { type: "https-token", secretId: credential.id },
        clone: { submodules: false, lfs: false, subdirectory: "" },
      },
    });
    assert.equal(project.source.type === "git-repository" ? project.source.auth.secretId : undefined, credential.id);
    await assert.rejects(
      () => service.gitCredentials.remove(credential.id),
      (error: { code?: string; details?: { repositories?: Array<{ id: string }> } }) => error.code === "GIT_CREDENTIAL_IN_USE"
        && error.details?.repositories?.[0]?.id === project.id,
    );
    await assert.rejects(
      () => service.gitCredentials.update(credential.id, { scope: { scheme: "https", host: "git.example.com", pathPrefix: "/other" } }),
      (error: { code?: string }) => error.code === "GIT_CREDENTIAL_REPOSITORY_SCOPE_MISMATCH",
    );
    service.updateProject(project.id, {
      source: {
        ...project.source,
        auth: { type: "none" },
      },
    });
    assert.equal(await service.gitCredentials.remove(credential.id), true);
    await database.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disabled credentials cannot be deployed or newly assigned", async () => {
  const { dataDir, database, service } = await fixture();
  try {
    const credential = await service.create({
      name: "Token",
      scope: { scheme: "https", host: "git.example.com" },
      secret: { kind: "https-token", username: "git", token: "secret" },
    });
    await service.disable(credential.id);
    await assert.rejects(() => service.payload(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_DISABLED");
    await assert.rejects(() => service.authorize("inst_one", credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_DISABLED");
  } finally {
    await database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Git credential routes require secrets permission and never return secret input", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-routes-"));
  const app = await createControlPlaneApp({ dataDir, logger: false, staticDir: path.join(os.tmpdir(), "missing-control-plane-ui"), auth: { mode: "password" } });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  const cookie = String(login.headers["set-cookie"]);
  const created = await app.inject({
    method: "POST",
    url: "/api/git-credentials",
    headers: { cookie },
    payload: {
      name: "Team token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "route-secret" },
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.stringify(created.json()).includes("route-secret"), false);
  const listed = await app.inject({ method: "GET", url: "/api/git-credentials", headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().data.items.length, 1);
  assert.equal(JSON.stringify(listed.json()).includes("route-secret"), false);
  const credentialId = created.json().data.id;
  const repository = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie },
    payload: {
      name: "Private repository",
      source: {
        type: "git-repository",
        url: "https://git.example.com/team/repo.git",
        ref: { type: "branch", name: "main" },
        auth: { type: "https-token", secretId: credentialId },
        clone: { submodules: false, lfs: false, subdirectory: "" },
      },
    },
  });
  assert.equal(repository.statusCode, 201);

  await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie },
    payload: { username: "operator", password: "password456", roleIds: ["role_operator"], nodeScope: { kind: "all" }, requirePasswordChange: false },
  });
  const operatorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "password456" } });
  const forbidden = await app.inject({ method: "GET", url: "/api/git-credentials", headers: { cookie: String(operatorLogin.headers["set-cookie"]) } });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "CONTROL_PLANE_FORBIDDEN");
  const forbiddenDetach = await app.inject({
    method: "PATCH",
    url: `/api/projects/${repository.json().data.id}`,
    headers: { cookie: String(operatorLogin.headers["set-cookie"]) },
    payload: {
      source: {
        ...repository.json().data.source,
        auth: { type: "none" },
      },
    },
  });
  assert.equal(forbiddenDetach.statusCode, 403);
  assert.equal(forbiddenDetach.json().error.code, "CONTROL_PLANE_FORBIDDEN");
});
