const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ProjectSourceSchema,
  sanitizeStoredProject,
  normalizeControlledInstanceCapabilities,
  normalizeNodeAgentCapabilities,
  supportsGitCliCredentialBroker,
  supportsNodeGitWorkspaceProvisioning,
  supportsNodeManagedGitCredentialRegistry,
} = require("../packages/protocol/src/control-plane.ts");
const { RepositoryErrorSchema } = require("../packages/protocol/src/repository.ts");
const { InstancePrivateConfigStore } = require("../packages/control-plane/src/node-agent/instances/private-config-store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { CreateProjectInputSchema, UpdateProjectInputSchema } = require("../packages/control-plane/src/control-plane/catalog/inputs.ts");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/v0.0.21-managed-git-baseline.json"), "utf8"));

test("v0.0.21 Git source auth remains readable but does not imply a managed capability", () => {
  const source = ProjectSourceSchema.parse(fixture.projectSource);
  assert.equal(source.auth.secretId, "legacy_secret");
  assert.equal(supportsNodeGitWorkspaceProvisioning(fixture.nodeCapabilities, "docker"), false);
  assert.equal(supportsGitCliCredentialBroker(fixture.controlledInstanceCapabilities), false);
  assert.equal(normalizeNodeAgentCapabilities(fixture.nodeCapabilities).folderPlaces, true);
  assert.equal(normalizeControlledInstanceCapabilities(fixture.controlledInstanceCapabilities).features.tty, true);
});

test("v0.0.21 malformed Git refs migrate according to the old executor precedence", () => {
  const base = { id: "proj_ref", name: "Ref", labels: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const source = { type: "git-repository", url: "https://git.example.com/repo.git", auth: { type: "none" }, clone: {} };
  const commit = sanitizeStoredProject({ ...base, source: { ...source, ref: { type: "branch", name: "ignored", commit: "deadbeef" } } });
  assert.deepEqual(commit.source.ref, { type: "commit", commit: "deadbeef" });
  const fallback = sanitizeStoredProject({ ...base, source: { ...source, ref: { type: "tag" } } });
  assert.deepEqual(fallback.source.ref, { type: "branch", name: "main" });
});

test("managed Git capability combinations degrade only the unsupported credential domain", () => {
  const oldNode = fixture.nodeCapabilities;
  const provisioningOnlyNode = {
    managedGitCredentials: { registry: true, workspaceProvisioning: { docker: true } },
  };
  const oldInstance = fixture.controlledInstanceCapabilities;
  const brokerInstance = { features: { gitCliCredentialBroker: true, tty: true } };

  assert.deepEqual([
    supportsNodeManagedGitCredentialRegistry(oldNode),
    supportsNodeGitWorkspaceProvisioning(oldNode, "docker"),
    supportsGitCliCredentialBroker(oldInstance),
  ], [false, false, false]);
  assert.deepEqual([
    supportsNodeManagedGitCredentialRegistry(provisioningOnlyNode),
    supportsNodeGitWorkspaceProvisioning(provisioningOnlyNode, "docker"),
    supportsGitCliCredentialBroker(oldInstance),
  ], [true, true, false]);
  assert.deepEqual([
    supportsNodeManagedGitCredentialRegistry(provisioningOnlyNode),
    supportsNodeGitWorkspaceProvisioning(provisioningOnlyNode, "docker"),
    supportsGitCliCredentialBroker(brokerInstance),
  ], [true, true, true]);
  assert.equal(normalizeNodeAgentCapabilities(oldNode).folderPlaces, true);
  assert.equal(normalizeControlledInstanceCapabilities(oldInstance).features.tty, true);
});

test("new Project producers preserve the v0.0.21 Repository credential reference", () => {
  const create = CreateProjectInputSchema.parse({ name: "Legacy", source: fixture.projectSource });
  const update = UpdateProjectInputSchema.parse({ source: fixture.projectSource });
  assert.deepEqual(create.source.auth, { type: "https-token", secretId: "legacy_secret" });
  assert.deepEqual(update.source.auth, { type: "https-token", secretId: "legacy_secret" });
  assert.equal(fixture.projectSource.auth.secretId, "legacy_secret");
});

test("v0.0.21 Repository authentication error remains valid", () => {
  assert.deepEqual(RepositoryErrorSchema.parse(fixture.repositoryError), fixture.repositoryError);
});

test("v0.0.21 instance private config migrates without losing its instance credential", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-v21-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    store.init();
    fs.writeFileSync(store.filePath(fixture.instancePrivateConfig.instanceId), JSON.stringify(fixture.instancePrivateConfig));
    const migrated = store.get(fixture.instancePrivateConfig.instanceId);
    assert.equal(migrated.instanceCredential, fixture.instancePrivateConfig.registrationToken);
    assert.equal("gitCredentials" in migrated, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.0.21 entrypoint clone boundary is fixed as a compatibility fixture", () => {
  const entrypoint = fs.readFileSync(path.join(__dirname, "../docker/entrypoint.sh"), "utf8");
  assert.match(entrypoint, new RegExp(`${fixture.dockerEntrypoint.cloneFunction}\\(\\)`));
  assert.equal(entrypoint.includes(fixture.dockerEntrypoint.sourceEnvironment), true);
  assert.equal(entrypoint.includes(fixture.dockerEntrypoint.urlEnvironment), true);
  assert.equal(entrypoint.includes(fixture.dockerEntrypoint.emptyWorkspaceGuard), true);
});
