const assert = require("node:assert/strict");
const test = require("node:test");

const { ControlPlaneService, runtimeCwdForNodePath } = require("../packages/control-plane/src/control-plane/application/service.ts");

function instance(sourcePath, workspacePath = "/workspace") {
  return {
    source: { type: "local-folder", path: sourcePath },
    runtime: { workspacePath },
    workspace: { status: "ready", path: workspacePath },
  };
}

test("AI session cwd maps a Windows node folder into the Docker workspace", () => {
  assert.equal(
    runtimeCwdForNodePath(instance("C:\\work\\project"), "C:\\work\\project\\packages\\web", { type: "docker" }),
    "/workspace/packages/web",
  );
});

test("AI session cwd preserves native paths for Local Runtime", () => {
  assert.equal(
    runtimeCwdForNodePath(instance("C:\\work\\project", "C:\\work\\project"), "C:\\work\\project\\packages\\web", { type: "local" }),
    "C:\\work\\project\\packages\\web",
  );
});

test("AI session cwd does not map a Docker folder outside the mounted workspace", () => {
  assert.equal(
    runtimeCwdForNodePath(instance("C:\\work\\project"), "C:\\other\\project", { type: "docker" }),
    undefined,
  );
});

test("AI session creation resolves a node folder identity before calling the instance action service", async () => {
  const service = Object.create(ControlPlaneService.prototype);
  const controlledInstance = {
    ...instance("C:\\work\\project"),
    id: "instance-1",
    nodeId: "node-1",
    runtimeId: "runtime-1",
  };
  service.requireControlledInstance = async () => controlledInstance;
  service.runtimeCwdForFolderId = async (_instance, folderId) => {
    assert.equal(folderId, "folder-1");
    return "/workspace/packages/web";
  };
  service.aiSessionActionService = {
    create: async (instanceId, input) => ({ instanceId, input }),
  };

  const result = await service.createAiSession("instance-1", {
    agent: "codex",
    cwdFolderId: "folder-1",
    message: "Implement it",
    attachments: [],
    references: [],
    clientRequestId: "request-1",
  });

  assert.equal(result.instanceId, "instance-1");
  assert.deepEqual(result.input.cwd, { type: "runtime-path", path: "/workspace/packages/web" });
  assert.equal("cwdFolderId" in result.input, false);
});

test("AI session creation uses the instance workspace when no folder is selected", async () => {
  const service = Object.create(ControlPlaneService.prototype);
  service.requireControlledInstance = async () => ({
    ...instance("C:\\work\\project"),
    id: "instance-1",
    nodeId: "node-1",
    runtimeId: "runtime-1",
  });
  service.aiSessionActionService = {
    create: async (_instanceId, input) => input,
  };

  const result = await service.createAiSession("instance-1", {
    agent: "codex",
    message: "Implement it",
    attachments: [],
    references: [],
    clientRequestId: "request-1",
  });

  assert.deepEqual(result.cwd, { type: "runtime-path", path: "/workspace" });
});
