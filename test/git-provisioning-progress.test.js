const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { GitProvisioningTerminalEventType, InstanceLifecycleEventType } = require("../packages/protocol/src/control-plane.ts");
const {
  GitProvisioningTerminalParser,
  parseGitProvisioningMarker,
  redactGitUrlCredentials,
  stripTerminalFormatting,
} = require("../packages/protocol/src/workspace-git.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { GitProvisioningProgressProjector } = require("../packages/control-plane/src/control-plane/instances/git-provisioning-progress.ts");

function output(sequence, data, extra = {}) {
  return {
    instanceId: "inst_git_progress",
    generation: 0,
    remoteUrl: "https://git.example.test/team/repo.git",
    sequence,
    observedAt: new Date().toISOString(),
    data,
    ...extra,
  };
}

test("Git provisioning markers parse and config credentials are redacted", () => {
  assert.deepEqual(parseGitProvisioningMarker("TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning"), { stage: "cloning" });
  assert.deepEqual(parseGitProvisioningMarker("TASK_HANDOFF_GIT_PROVISIONING_COMMIT=abc123"), { commit: "abc123" });
  assert.deepEqual(parseGitProvisioningMarker("TASK_HANDOFF_GIT_PROVISIONING_ERROR=CLONE_FAILED"), { errorCode: "CLONE_FAILED" });
  assert.equal(parseGitProvisioningMarker("TASK_HANDOFF_GIT_PROVISIONING_STAGE=unknown"), undefined);
  assert.equal(parseGitProvisioningMarker("Receiving objects: 100%"), undefined);
  assert.equal(redactGitUrlCredentials("fetch https://git-user:token@host/team/repo.git"), "fetch https://***@host/team/repo.git");
  assert.equal(stripTerminalFormatting("\u001b[1mReceiving objects\u001b[0m"), "Receiving objects");
});

test("git-provision.sh emits the machine-readable progress contract", () => {
  const script = fs.readFileSync(path.resolve("docker/git-provision.sh"), "utf8");
  assert.match(script, /TASK_HANDOFF_GIT_PROVISIONING_STAGE=%s/);
  assert.match(script, /TASK_HANDOFF_GIT_PROVISIONING_COMMIT=%s/);
  assert.match(script, /TASK_HANDOFF_GIT_PROVISIONING_ERROR=%s/);
  for (const stage of ["cloning", "checking-out", "submodules", "lfs", "finalizing"]) {
    assert.match(script, new RegExp(`stage ${stage}\\b`), `git-provision.sh must announce the ${stage} stage`);
  }
  // Git only prints transfer progress without a TTY when asked.
  assert.match(script, /clone --progress/);
});

test("Git provisioning parser separates display output from markers and keeps the failure reason", () => {
  const parser = new GitProvisioningTerminalParser();
  const first = parser.push("TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning\nCloning into 'checkout'...\n");
  assert.deepEqual(first.stage, "cloning");
  assert.equal(first.display, "Cloning into 'checkout'...\n");
  const second = parser.push("TASK_HANDOFF_GIT_PROVISIONING_COMMIT=abc\n");
  assert.equal(second.commit, "abc");
  assert.equal(second.display, "");
  parser.push("fatal: unable to access 'https://git-user:token@git.example.test/team/repo.git/'\n");
  assert.match(parser.failureDetail(), /^fatal: unable to access/);
  assert.equal(parser.failureDetail().includes("token"), true);
});

test("control-plane derives concise Git clone progress from the authoritative TTY", () => {
  const events = new ControlPlaneEventBus();
  const projector = new GitProvisioningProgressProjector(events);
  const progress = [];
  events.on((event) => {
    projector.handle(event);
    if (event.type === GitProvisioningTerminalEventType.Progress) progress.push(event.payload);
  });

  events.publish(GitProvisioningTerminalEventType.Output, output(1000, [
    "TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning\n",
    "Cloning into 'checkout'...\n",
    "remote: Counting objects: 3, done.\n",
    "Receiving objects:  45% (9/20)\rReceiving objects:  90% (18/20)\r",
  ].join("")), { scope: { instanceId: "inst_git_progress" } });
  events.publish(GitProvisioningTerminalEventType.Finished, {
    instanceId: "inst_git_progress",
    generation: 0,
    remoteUrl: "https://git.example.test/team/repo.git",
    sequence: 2000,
    observedAt: new Date().toISOString(),
    outcome: "succeeded",
  }, { scope: { instanceId: "inst_git_progress" } });

  assert.equal(progress.length, 1);
  assert.equal(progress[0].status, "complete");
  assert.deepEqual(progress[0].objects, { received: 18, total: 20 });
  const [snapshot] = projector.snapshots();
  assert.match(snapshot.terminalTail, /Cloning into 'checkout'/);
  assert.doesNotMatch(snapshot.terminalTail, /TASK_HANDOFF_GIT_PROVISIONING_/);
  projector.close();
});

test("failed Git provisioning keeps its terminal for diagnostics and clears when ready", () => {
  const events = new ControlPlaneEventBus();
  const projector = new GitProvisioningProgressProjector(events);
  events.on((event) => projector.handle(event));
  events.publish(GitProvisioningTerminalEventType.Output, output(1000, "fatal: could not resolve host\n"));
  events.publish(GitProvisioningTerminalEventType.Finished, {
    instanceId: "inst_git_progress",
    generation: 0,
    remoteUrl: "https://git.example.test/team/repo.git",
    sequence: 2000,
    observedAt: new Date().toISOString(),
    outcome: "failed",
  });
  const [failed] = projector.snapshots();
  assert.equal(failed.status, "failed");
  assert.match(failed.terminalTail, /could not resolve host/);

  events.publish(InstanceLifecycleEventType.Snapshot, {
    instanceId: "inst_git_progress",
    revision: 2,
    updatedAt: new Date().toISOString(),
    status: "failed",
    health: "failed",
    connectionStatus: "unknown",
    accessStatus: "endpoint-unreachable",
    ready: false,
    workspace: {
      mode: "git-clone",
      status: "failed",
      gitProvisioning: { phase: "failed", remoteUrl: "https://git.example.test/team/repo.git", generation: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    },
    runtime: { labels: {} },
  });
  assert.equal(projector.snapshots().length, 1, "failed diagnostics stay visible");

  events.publish(InstanceLifecycleEventType.Snapshot, {
    instanceId: "inst_git_progress",
    revision: 3,
    updatedAt: new Date().toISOString(),
    status: "created",
    health: "unknown",
    connectionStatus: "unknown",
    accessStatus: "endpoint-unreachable",
    ready: false,
    workspace: {
      mode: "git-clone",
      status: "ready",
      gitProvisioning: { phase: "ready", remoteUrl: "https://git.example.test/team/repo.git", generation: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    },
    runtime: { labels: {} },
  });
  assert.deepEqual(projector.snapshots(), []);
  projector.close();
});
