import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeAgentState } from "../src/node-agent/state.ts";
import { NodeGitCredentialStore } from "../src/node-agent/git-credentials/store.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

test("operation-only provisioning survives a node-agent restart and is consumed once", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-operation-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const state = new NodeAgentState(paths, "node_one", "http://127.0.0.1:8091", undefined, 8091, "linux");
    state.init();
    const input = {
      id: "inst_one",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_one" },
      image: {
        id: "img_one", origin: "custom" as const, name: "Image", repository: "task-handoff-web", tag: "latest",
        requestedReference: "task-handoff-web:latest", pullPolicy: "if-not-present" as const, capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
      },
      source: {
        type: "git-repository" as const,
        url: "https://git.example.com/team/repo.git",
        ref: { type: "branch" as const, name: "main" },
        auth: { type: "none" as const },
        clone: { submodules: false, lfs: false, subdirectory: "" },
      },
      sourceSnapshot: {},
      modelSelection: {},
      gitWorkspaceProvisioning: {
        operationId: "gitop_one",
        instanceId: "inst_one",
        remoteUrl: "https://git.example.com/team/repo.git",
        ref: { type: "branch" as const, name: "main" },
        clone: { submodules: false, lfs: false, subdirectory: "" },
        credentials: [{
          operationId: "gitcredop_one",
          retention: "operation-only" as const,
          payload: {
            credential: {
              id: "gitcred_one", name: "Token", kind: "https-token" as const,
              scope: { scheme: "https" as const, host: "git.example.com", pathPrefix: "/team/" },
              secretSet: true as const, status: "enabled" as const, revision: 1, createdAt: timestamp, updatedAt: timestamp,
            },
            secret: { kind: "https-token" as const, username: "git", token: "operation-secret" },
          },
        }],
      },
    };
    state.createInstance(input);
    const controlledRecord = fs.readFileSync(path.join(paths.controlledInstancesDir, "inst_one.json"), "utf8");
    const privateRecord = fs.readFileSync(state.instancePrivateConfigs.filePath("inst_one"), "utf8");
    assert.equal(controlledRecord.includes("operation-secret"), false);
    assert.equal(privateRecord.includes("operation-secret"), false);
    assert.deepEqual(fs.readdirSync(paths.gitCredentialPayloadsDir), []);
    const intentPath = path.join(paths.gitWorkspaceProvisioningIntentsDir, "inst_one.json");
    assert.equal(fs.statSync(intentPath).mode & 0o777, 0o600);
    const restored = new NodeAgentState(paths, "node_one", "http://127.0.0.1:8091", undefined, 8091, "linux");
    restored.init();
    assert.equal(restored.takeGitWorkspaceProvisioning("inst_one")?.credentials[0]?.payload.secret.kind, "https-token");
    assert.equal(restored.takeGitWorkspaceProvisioning("inst_one"), undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("instance-retained provisioning snapshots are not persisted beside the authorization source", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-retained-snapshot-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const state = new NodeAgentState(paths, "node_one", "http://127.0.0.1:8091", undefined, 8091, "linux");
    state.init();
    assert.throws(() => state.gitCredentials.putWorkspaceProvisioning({
      operationId: "gitop_retained",
      instanceId: "inst_one",
      remoteUrl: "https://git.example.com/team/repo.git",
      ref: { type: "branch", name: "main" },
      clone: { submodules: false, lfs: false, subdirectory: "" },
      credentials: [{
        operationId: "gitcredop_retained",
        retention: "instance-retained",
        payload: {
          credential: {
            id: "gitcred_one", name: "Token", kind: "https-token",
            scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/" },
            secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
          },
          secret: { kind: "https-token", username: "git", token: "retained-secret" },
        },
      }],
    }), (error: { code?: string }) => error.code === "GIT_CREDENTIAL_PROVISIONING_RETENTION_INVALID");
    assert.deepEqual(fs.readdirSync(paths.gitWorkspaceProvisioningIntentsDir), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("operation-only provisioning material is physically removed at its private-store deadline", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-operation-expiry-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new NodeGitCredentialStore(paths, { workspaceProvisioningTtlMs: 20 });
    store.init();
    store.putWorkspaceProvisioning({
      operationId: "gitop_expiring",
      instanceId: "inst_one",
      remoteUrl: "https://git.example.com/team/repo.git",
      ref: { type: "branch", name: "main" },
      clone: { submodules: false, lfs: false, subdirectory: "" },
      credentials: [{
        operationId: "gitcredop_expiring",
        retention: "operation-only",
        payload: {
          credential: {
            id: "gitcred_one", name: "Token", kind: "https-token",
            scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/" },
            secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
          },
          secret: { kind: "https-token", username: "git", token: "expiring-secret" },
        },
      }],
    });
    const intentPath = path.join(paths.gitWorkspaceProvisioningIntentsDir, "inst_one.json");
    assert.equal(fs.existsSync(intentPath), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fs.existsSync(intentPath), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a consumed operation leaves only a secret-free receipt for asynchronous acknowledgement", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-operation-receipt-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new NodeGitCredentialStore(paths);
    store.init();
    const input = {
      operationId: "gitop_consumed",
      instanceId: "inst_one",
      remoteUrl: "https://git.example.com/team/repo.git",
      ref: { type: "branch" as const, name: "main" },
      clone: { submodules: false, lfs: false, subdirectory: "" },
      credentials: [{
        operationId: "gitcredop_consumed",
        retention: "operation-only" as const,
        payload: {
          credential: {
            id: "gitcred_one", name: "Token", kind: "https-token" as const,
            scope: { scheme: "https" as const, host: "git.example.com", pathPrefix: "/team/" },
            secretSet: true as const, status: "enabled" as const, revision: 1, createdAt: timestamp, updatedAt: timestamp,
          },
          secret: { kind: "https-token" as const, username: "git", token: "consumed-secret" },
        },
      }],
    };
    store.putWorkspaceProvisioning(input);
    assert.equal(store.completeWorkspaceProvisioning("inst_one", input.operationId), true);
    assert.deepEqual(store.workspaceProvisioningStatus("inst_one"), { status: "consumed", operationId: input.operationId });
    const receiptPath = path.join(paths.gitWorkspaceProvisioningIntentsDir, "inst_one.json");
    assert.equal(fs.readFileSync(receiptPath, "utf8").includes("consumed-secret"), false);

    const restored = new NodeGitCredentialStore(paths);
    restored.init();
    restored.putWorkspaceProvisioning(input);
    assert.deepEqual(restored.workspaceProvisioningStatus("inst_one"), { status: "consumed", operationId: input.operationId });
    assert.equal(fs.readFileSync(receiptPath, "utf8").includes("consumed-secret"), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
