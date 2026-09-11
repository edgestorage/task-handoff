import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";
import { ControlPlaneGitRepository } from "../src/control-plane/git-credentials/repository.ts";
import { ControlPlaneGitCredentialService } from "../src/control-plane/git-credentials/service.ts";

test("Git repository encrypts credentials, applies assignment CAS, and replays provisioning idempotently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-git-db-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneGitRepository(database, secrets);
  const timestamp = new Date().toISOString();
  try {
    await repository.putCredential({ id: "gitcred_one", name: "One", kind: "https-token", scope: { scheme: "https", host: "git.example.com", pathPrefix: "/" }, secretSet: true, status: "enabled", revision: 1, secret: { kind: "https-token", username: "git", token: "plain-token" }, createdAt: timestamp, updatedAt: timestamp });
    assert.equal((await repository.getCredentialEntity("gitcred_one"))?.secret.kind, "https-token");
    assert.doesNotMatch((await database.gitCredentials.get("gitcred_one"))!.secretCiphertext, /plain-token/);

    const assignment = { id: "instance_one:gitcred_one", instanceId: "instance_one", credentialId: "gitcred_one", credentialRevision: 1, assignmentRevision: 1, status: "pending" as const, authorizedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
    await repository.putAssignment(assignment, undefined);
    await assert.rejects(() => repository.putAssignment({ ...assignment, assignmentRevision: 2, status: "synced" }, 0), (error: any) => error.code === "GIT_CREDENTIAL_ASSIGNMENT_REVISION_CONFLICT");
    await repository.putAssignment({ ...assignment, assignmentRevision: 2, status: "synced" }, 1);
    await repository.putAssignment({ ...assignment, id: "instance_two:gitcred_one", instanceId: "instance_two" }, undefined);
    assert.deepEqual((await repository.listAssignments()).map((item) => item.instanceId), ["instance_one", "instance_two"]);

    const intent = { id: "instance_one", instanceId: "instance_one", credentialId: "gitcred_one", operationId: "operation_one", remoteUrl: "https://git.example.com/repo.git", ref: { type: "branch" as const, name: "main" }, clone: { submodules: false, lfs: false, subdirectory: "" }, createdAt: timestamp, updatedAt: timestamp };
    const first = await repository.rememberProvisioningIntent(intent);
    const replay = await repository.rememberProvisioningIntent(intent);
    assert.equal(replay.inputDigest, first.inputDigest);
    await assert.rejects(() => repository.rememberProvisioningIntent({ ...intent, operationId: "operation_two" }), (error: any) => error.code === "GIT_CREDENTIAL_PROVISIONING_OPERATION_CONFLICT");
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git service rolls back credential creation when audit append fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-git-audit-failure-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const failingDatabase = {
    ...database,
    transaction: <T>(operation: Parameters<typeof database.transaction<T>>[0]) => database.transaction((transaction) => operation({
      ...transaction,
      gitAudit: {
        ...transaction.gitAudit,
        append: async () => { throw new Error("injected Git audit failure"); },
      },
    })),
  };
  const service = new ControlPlaneGitCredentialService(new ControlPlaneGitRepository(failingDatabase, secrets));
  await service.init();
  try {
    await assert.rejects(() => service.create({
      name: "Rollback", scope: { scheme: "https", host: "git.example.com" },
      secret: { kind: "https-token", username: "git", token: "must-not-commit" },
    }), /injected Git audit failure/);
    assert.equal((await database.gitCredentials.list()).length, 0);
    assert.equal((await database.gitAudit.list()).length, 0);
    assert.equal(service.list().length, 0);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git credential mutation and audit roll back together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-git-tx-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneGitRepository(database, secrets);
  const timestamp = new Date().toISOString();
  try {
    await assert.rejects(() => repository.transaction(async (transaction) => {
      await transaction.putCredential({ id: "gitcred_rollback", name: "Rollback", kind: "https-token", scope: { scheme: "https", host: "git.example.com", pathPrefix: "/" }, secretSet: true, status: "enabled", revision: 1, secret: { kind: "https-token", username: "git", token: "token" }, createdAt: timestamp, updatedAt: timestamp });
      await transaction.appendAudit({ id: "audit_rollback", action: "create", credentialId: "gitcred_rollback", credentialRevision: 1, createdAt: timestamp, updatedAt: timestamp });
      throw new Error("force Git rollback");
    }), /force Git rollback/);
    assert.equal(await repository.getCredential("gitcred_rollback"), undefined);
    assert.equal(await database.gitAudit.get("audit_rollback"), undefined);

    const audit = { id: "audit_once", action: "delete" as const, credentialId: "gitcred_gone", createdAt: timestamp, updatedAt: timestamp };
    await repository.appendAudit(audit);
    await assert.rejects(() => repository.appendAudit(audit));
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
