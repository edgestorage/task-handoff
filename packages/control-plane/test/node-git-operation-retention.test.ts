import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeAgentState } from "../src/node-agent/state.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

test("operation-only provisioning credential remains in node-agent memory and is consumed once", () => {
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
    assert.equal(state.takeGitWorkspaceProvisioning("inst_one")?.credentials[0]?.payload.secret.kind, "https-token");
    assert.equal(state.takeGitWorkspaceProvisioning("inst_one"), undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
