const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  LEGACY_WORKSPACE_GIT_ENV,
  WORKSPACE_GIT_ENV,
  workspaceGitEnvironmentValue,
} = require("../packages/protocol/src/workspace-git.ts");

test("workspace Git environment keeps provisioning input separate from image build metadata", () => {
  const imageBuildMetadata = {
    TASK_HANDOFF_GIT_COMMIT: "35d682e84b1391850ef92c1bd22cbf66c35eeb0a",
    TASK_HANDOFF_BUILD_ID: "34365048143",
  };
  assert.equal(workspaceGitEnvironmentValue(imageBuildMetadata, "commit"), undefined);

  const launched = {
    ...imageBuildMetadata,
    [WORKSPACE_GIT_ENV.url]: "https://example.com/repo.git",
    [WORKSPACE_GIT_ENV.ref]: "main",
    [WORKSPACE_GIT_ENV.commit]: "",
  };
  assert.equal(workspaceGitEnvironmentValue(launched, "url"), "https://example.com/repo.git");
  assert.equal(workspaceGitEnvironmentValue(launched, "ref"), "main");
  assert.equal(workspaceGitEnvironmentValue(launched, "commit"), undefined);

  const committed = { [WORKSPACE_GIT_ENV.commit]: "abc123" };
  assert.equal(workspaceGitEnvironmentValue(committed, "commit"), "abc123");
});

test("workspace Git environment reads legacy keys for older node agents but never the legacy commit", () => {
  const olderNodeAgent = {
    [LEGACY_WORKSPACE_GIT_ENV.url]: "https://example.com/legacy.git",
    [LEGACY_WORKSPACE_GIT_ENV.ref]: "release",
    [LEGACY_WORKSPACE_GIT_ENV.depth]: "1",
    TASK_HANDOFF_GIT_COMMIT: "35d682e84b1391850ef92c1bd22cbf66c35eeb0a",
  };
  assert.equal(workspaceGitEnvironmentValue(olderNodeAgent, "url"), "https://example.com/legacy.git");
  assert.equal(workspaceGitEnvironmentValue(olderNodeAgent, "ref"), "release");
  assert.equal(workspaceGitEnvironmentValue(olderNodeAgent, "depth"), "1");
  assert.equal(workspaceGitEnvironmentValue(olderNodeAgent, "commit"), undefined);

  const preferred = { ...olderNodeAgent, [WORKSPACE_GIT_ENV.ref]: "main" };
  assert.equal(workspaceGitEnvironmentValue(preferred, "ref"), "main");
});

test("workspace Git scripts only read the workspace namespace for checkout input", () => {
  const provisioning = fs.readFileSync(path.resolve("docker/git-provision.sh"), "utf8");
  for (const name of Object.values(WORKSPACE_GIT_ENV)) {
    assert.equal(provisioning.includes(name), true, `git-provision.sh must use ${name}`);
  }
  assert.doesNotMatch(provisioning, /\$\{TASK_HANDOFF_GIT_(?:URL|REF|COMMIT|DEPTH|SUBMODULES|LFS)/);

  const entrypoint = fs.readFileSync(path.resolve("docker/entrypoint.sh"), "utf8");
  // The entrypoint bootstraps the workspace but does not pull LFS.
  for (const key of ["url", "ref", "commit", "depth", "submodules"]) {
    assert.equal(entrypoint.includes(WORKSPACE_GIT_ENV[key]), true, `entrypoint.sh must use ${WORKSPACE_GIT_ENV[key]}`);
  }
  // The entrypoint ships with the node agent that writes the environment, so it
  // never reads the legacy keys (comments may still name them).
  for (const name of Object.values(LEGACY_WORKSPACE_GIT_ENV)) {
    assert.doesNotMatch(entrypoint, new RegExp(`\\$\\{${name}`), `entrypoint.sh must not read ${name}`);
  }
  assert.doesNotMatch(entrypoint, /\$\{TASK_HANDOFF_GIT_COMMIT/, "entrypoint.sh must not read the image build commit");
});
