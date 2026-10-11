import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorContext } from "../src/node-agent/runtimes/docker.ts";
import {
  WSL_GIT_CREDENTIAL_HELPER,
  WSL_GIT_PROVISION_COMMIT_PREFIX,
  WSL_GIT_PROVISION_SCRIPT,
  WSL_GIT_PROVISION_STAGE_PREFIX,
  WslGitWorkspaceProvisioner,
} from "../src/node-agent/runtimes/wsl-git-provisioning.ts";

function context(credentials: unknown[] = []) {
  return {
    instance: { id: "inst_a" },
    project: { source: { type: "git" }, workspacePolicy: { path: "/workspace" } },
    gitWorkspaceProvisioning: {
      operationId: "gitop_1",
      instanceId: "inst_a",
      remoteUrl: "https://example.com/x.git",
      ref: { type: "branch", name: "main" },
      clone: { depth: 1, submodules: true, lfs: false, subdirectory: "" },
      credentials,
    },
    completeGitWorkspaceProvisioning: () => { completed = true; },
  } as unknown as ExecutorContext;
}

let completed = false;

function fakeExecutor(result: { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: string[][] = [];
  return {
    calls,
    copied: [] as Array<{ destination: string }>,
    async execOrThrow(_name: string, argv: readonly string[]) { calls.push([...argv]); return { stdout: "", stderr: "", exitCode: 0 }; },
    async execStream(_name: string, argv: readonly string[]) {
      calls.push([...argv]);
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
    },
    async copyIntoDistro(_name: string, _source: string, destination: string) { this.copied.push({ destination }); },
  };
}

test("provision bridges scripts and credentials then reports stages and commit", async () => {
  completed = false;
  const executor = fakeExecutor({ stdout: `${WSL_GIT_PROVISION_STAGE_PREFIX}cloning\n${WSL_GIT_PROVISION_STAGE_PREFIX}finalizing\n${WSL_GIT_PROVISION_COMMIT_PREFIX}abc123\n` });
  const provisioner = new WslGitWorkspaceProvisioner({ executor });
  const result = await provisioner.provision(context(), "th-wsl-inst_a", {});
  assert.deepEqual(result.stages, ["cloning", "finalizing"]);
  assert.equal(result.commit, "abc123");
  assert.equal(completed, true);
  assert.ok(executor.copied.some((entry) => entry.destination === WSL_GIT_PROVISION_SCRIPT));
  assert.ok(executor.copied.some((entry) => entry.destination === WSL_GIT_CREDENTIAL_HELPER));
});

test("a failed provisioning surfaces the script error marker and cleans the auth bridge", async () => {
  completed = false;
  const executor = fakeExecutor({ stderr: "TASK_HANDOFF_GIT_PROVISIONING_ERROR=CLONE_FAILED\n", exitCode: 74 });
  const provisioner = new WslGitWorkspaceProvisioner({ executor });
  await assert.rejects(provisioner.provision(context(), "th-wsl-inst_a", {}), (error: { details?: { code?: string } }) => error.details?.code === "CLONE_FAILED");
  assert.ok(executor.calls.some((argv) => (argv[2] ?? "").includes("rm -rf /run/task-handoff/git-auth")));
});

test("git environment never exposes secrets and declares the workspace contract", async () => {
  const executor = fakeExecutor({ stdout: "" });
  const provisioner = new WslGitWorkspaceProvisioner({ executor });
  await provisioner.provision(context([{ payload: { credential: { scope: {} }, secret: { kind: "https-token", username: "u", token: "secret-token" } } }]), "th-wsl-inst_a", {});
  const command = executor.calls.map((argv) => argv[2] ?? "").join("\n");
  assert.ok(command.includes("TASK_HANDOFF_WORKSPACE_GIT_URL='https://example.com/x.git'"));
  assert.ok(!command.includes("secret-token"));
});
