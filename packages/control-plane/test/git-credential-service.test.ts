import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { ControlPlaneGitCredentialService } from "../src/control-plane/git-credentials/service.ts";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { createControlPlaneApp } from "../src/control-plane/http/server.ts";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-credentials-"));
  const service = new ControlPlaneGitCredentialService(controlPlaneStorePaths(dataDir));
  service.init();
  return { dataDir, service };
}

test("Git credential CRUD exposes only public projections and preserves secrets on metadata update", () => {
  const { dataDir, service } = fixture();
  try {
    const created = service.create({
      name: "Team token",
      scope: { scheme: "https", host: "Git.Example.com", port: 443, pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "secret-one" },
    });
    assert.equal(created.scope.host, "git.example.com");
    assert.equal(created.scope.port, undefined);
    assert.equal("token" in created, false);
    assert.equal(JSON.stringify(service.list()).includes("secret-one"), false);
    assert.equal(service.payload(created.id).secret.kind, "https-token");
    assert.equal(service.payload(created.id).secret.kind === "https-token" ? service.payload(created.id).secret.token : "", "secret-one");

    const updated = service.update(created.id, { name: "Renamed" });
    assert.equal(updated.revision, 2);
    assert.equal(service.payload(created.id).secret.kind === "https-token" ? service.payload(created.id).secret.token : "", "secret-one");
    service.update(created.id, { secret: { kind: "https-token", username: "git", token: "secret-two" } });
    assert.equal(service.payload(created.id).secret.kind === "https-token" ? service.payload(created.id).secret.token : "", "secret-two");

    const persisted = fs.readFileSync(path.join(controlPlaneStorePaths(dataDir).gitCredentialsDir, `${created.id}.json`), "utf8");
    assert.equal(persisted.includes("secret-one"), false);
    assert.equal(persisted.includes("secret-two"), false);
    assert.equal(fs.statSync(controlPlaneStorePaths(dataDir).gitCredentialsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(controlPlaneStorePaths(dataDir).gitCredentialsDir, `${created.id}.json`)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("assignment lifecycle protects referenced credentials and uses monotonic revisions", () => {
  const { dataDir, service } = fixture();
  try {
    const credential = service.create({
      name: "SSH",
      scope: { scheme: "ssh", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "ssh-key", privateKey: "private-key", passphrase: "passphrase", pinnedKnownHosts: "git.example.com ssh-ed25519 AAAA" },
    });
    const pending = service.authorize("inst_one", credential.id);
    assert.equal(pending.status, "pending");
    const synced = service.markAssignmentStatus("inst_one", credential.id, "synced");
    assert.equal(synced.assignmentRevision, pending.assignmentRevision + 1);
    assert.throws(() => service.remove(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_IN_USE");
    assert.equal(service.revoke("inst_one", credential.id), true);
    const reauthorized = service.authorize("inst_one", credential.id);
    assert.ok(reauthorized.assignmentRevision > synced.assignmentRevision);
    assert.equal(service.revoke("inst_one", credential.id), true);
    assert.equal(service.remove(credential.id), true);
    const auditDir = controlPlaneStorePaths(dataDir).gitCredentialAuditDir;
    const auditText = fs.readdirSync(auditDir)
      .map((name) => fs.readFileSync(path.join(auditDir, name), "utf8"))
      .join("\n");
    assert.equal(auditText.includes("private-key"), false);
    assert.equal(auditText.includes("passphrase"), false);
    assert.equal(auditText.includes("git.example.com ssh-ed25519"), false);
    assert.match(auditText, /"action": "authorize"/);
    assert.match(auditText, /"action": "revoke"/);
    assert.equal(fs.statSync(auditDir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(auditDir)) {
      assert.equal(fs.statSync(path.join(auditDir, name)).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deferred revocation is retried and releases the credential deletion guard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-revoke-retry-"));
  try {
    const service = new ControlPlaneService(controlPlaneStorePaths(dataDir));
    const credential = service.gitCredentials.create({
      name: "Team token",
      scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team" },
      secret: { kind: "https-token", username: "git", token: "secret" },
    });
    service.gitCredentials.authorize("inst_one", credential.id);
    service.gitCredentials.markAssignmentStatus("inst_one", credential.id, "revoking");

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
    assert.throws(() => service.gitCredentials.remove(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_IN_USE");

    await service.recoverPendingPairingRevokes();
    assert.equal(attempts, 2);
    assert.deepEqual(service.gitCredentials.listAssignments("inst_one"), []);
    assert.equal(service.gitCredentials.remove(credential.id), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Git Repository owns its credential reference and protects it from deletion or incompatible scope changes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-repository-auth-"));
  try {
    const service = new ControlPlaneService(controlPlaneStorePaths(dataDir));
    const credential = service.gitCredentials.create({
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
    assert.throws(
      () => service.gitCredentials.remove(credential.id),
      (error: { code?: string; details?: { repositories?: Array<{ id: string }> } }) => error.code === "GIT_CREDENTIAL_IN_USE"
        && error.details?.repositories?.[0]?.id === project.id,
    );
    assert.throws(
      () => service.gitCredentials.update(credential.id, { scope: { scheme: "https", host: "git.example.com", pathPrefix: "/other" } }),
      (error: { code?: string }) => error.code === "GIT_CREDENTIAL_REPOSITORY_SCOPE_MISMATCH",
    );
    service.updateProject(project.id, {
      source: {
        ...project.source,
        auth: { type: "none" },
      },
    });
    assert.equal(service.gitCredentials.remove(credential.id), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disabled credentials cannot be deployed or newly assigned", () => {
  const { dataDir, service } = fixture();
  try {
    const credential = service.create({
      name: "Token",
      scope: { scheme: "https", host: "git.example.com" },
      secret: { kind: "https-token", username: "git", token: "secret" },
    });
    service.disable(credential.id);
    assert.throws(() => service.payload(credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_DISABLED");
    assert.throws(() => service.authorize("inst_one", credential.id), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_DISABLED");
  } finally {
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
