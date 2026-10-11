const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BUILTIN_PROJECT_CONTENT_DIR,
  BUILTIN_PROJECT_MANIFEST_FILE,
  builtinProjectContentDigest,
  builtinProjectSkillTargetDir,
  listBuiltinProjectFiles,
  loadBuiltinProjectDefinitions,
  packagedBuiltinProjectsDir,
  readBuiltinProjectSource,
} = require("../packages/control-plane/src/node-agent/builtin-projects/assets.ts");
const {
  BUILTIN_PROJECT_MARKER_DIR,
  BUILTIN_PROJECT_MARKER_FILE,
  ensureBuiltinProjectMaterialized,
  readBuiltinProjectMarker,
} = require("../packages/control-plane/src/node-agent/builtin-projects/initializer.ts");
const {
  builtinProjectFolderId,
  createBuiltinProjectFolderProjection,
} = require("../packages/control-plane/src/node-agent/builtin-projects/catalog.ts");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent/app.ts");
const { NodeLocalFolderSchema, sanitizeStoredNodeLocalFolder } = require("../packages/protocol/src/control-plane.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { NodeAgentState } = require("../packages/control-plane/src/node-agent/state.ts");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Builds a hermetic built-in project source so the tests never depend on shipped content. */
function builtinProjectFixture(t, options = {}) {
  const sourceRoot = tempDir(t, "task-handoff-builtin-source-");
  const projectRoot = path.join(sourceRoot, "assistant");
  const contentDir = path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR);
  fs.mkdirSync(path.join(contentDir, ".agents", "skills", "taskhandoff", "references"), { recursive: true });
  fs.writeFileSync(path.join(contentDir, ".agents", "skills", "taskhandoff", "SKILL.md"), "---\nname: taskhandoff\n---\n");
  fs.writeFileSync(path.join(contentDir, ".agents", "skills", "taskhandoff", "references", "nodes.md"), "nodes\n");
  const digest = options.digest || builtinProjectContentDigest(listBuiltinProjectFiles(contentDir));
  const localizedNames = options.localizedNames === undefined
    ? { "en-US": "Assistant", "zh-CN": "助理" }
    : options.localizedNames;
  fs.writeFileSync(path.join(projectRoot, BUILTIN_PROJECT_MANIFEST_FILE), `${JSON.stringify({
    schemaVersion: 1,
    id: options.id || "assistant",
    name: options.name || "Assistant",
    ...(localizedNames ? { localizedNames } : {}),
    runtimes: options.runtimes || ["local"],
    contentDigest: digest,
  }, null, 2)}\n`);
  return { sourceRoot, projectRoot, contentDir, digest };
}

// The tracked declaration is the only committed part of a built-in project; its
// content and manifest are materialized at build time by
// scripts/sync-builtin-projects.mjs and covered by builtin-projects-sync.test.js.
test("the shipped built-in project declaration points at the published skill", () => {
  const source = readBuiltinProjectSource(path.join(packagedBuiltinProjectsDir(), "assistant"));
  assert.equal(source.id, "assistant");
  assert.equal(source.name, "Assistant");
  assert.equal(source.localizedNames?.["zh-CN"], "助理");
  assert.deepEqual(source.runtimes, ["local"]);
  assert.equal(source.skill.name, "taskhandoff");
  assert.equal(builtinProjectSkillTargetDir(source.skill), ".agents/skills/taskhandoff");
});

test("built-in project skill targets stay inside the content directory", () => {
  assert.equal(builtinProjectSkillTargetDir({ name: "taskhandoff" }), ".agents/skills/taskhandoff");
  assert.equal(builtinProjectSkillTargetDir({ name: "taskhandoff", targetDir: "./skills/taskhandoff" }), "skills/taskhandoff");
  for (const targetDir of ["/absolute", "../escape", "nested/../../escape", "C:/escape", ""]) {
    assert.throws(() => builtinProjectSkillTargetDir({ name: "taskhandoff", targetDir }), { code: "BUILTIN_PROJECT_SOURCE_INVALID" });
  }
});

test("built-in project content that does not match its manifest is refused", (t) => {
  const fixture = builtinProjectFixture(t);
  fs.appendFileSync(path.join(fixture.contentDir, ".agents", "skills", "taskhandoff", "SKILL.md"), "tampered\n");
  assert.throws(() => loadBuiltinProjectDefinitions(fixture.sourceRoot), { code: "BUILTIN_PROJECT_CONTENT_INVALID" });
});

test("built-in project materializes once and never rewrites a marked directory", (t) => {
  const fixture = builtinProjectFixture(t);
  const [definition] = loadBuiltinProjectDefinitions(fixture.sourceRoot);
  const targetsRoot = tempDir(t, "task-handoff-builtin-targets-");
  const targetDir = path.join(targetsRoot, "assistant");

  const first = ensureBuiltinProjectMaterialized(definition, targetDir, { instanceId: "inst_one", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.status, "initialized");
  assert.equal(first.filesWritten, definition.files.length);
  assert.equal(fs.readFileSync(path.join(targetDir, ".agents", "skills", "taskhandoff", "SKILL.md"), "utf8"), "---\nname: taskhandoff\n---\n");
  const marker = readBuiltinProjectMarker(targetDir);
  assert.equal(marker.projectId, "assistant");
  assert.equal(marker.contentDigest, definition.contentDigest);
  assert.equal(marker.instanceId, "inst_one");

  // A user edit after initialization must survive a later trigger untouched.
  const skillPath = path.join(targetDir, ".agents", "skills", "taskhandoff", "SKILL.md");
  fs.writeFileSync(skillPath, "locally edited\n");
  const stamp = fs.statSync(skillPath).mtimeMs;

  const second = ensureBuiltinProjectMaterialized(definition, targetDir, { instanceId: "inst_two" });
  assert.equal(second.status, "already-initialized");
  assert.equal(fs.readFileSync(skillPath, "utf8"), "locally edited\n");
  assert.equal(fs.statSync(skillPath).mtimeMs, stamp);
  assert.equal(readBuiltinProjectMarker(targetDir).instanceId, "inst_one");
});

test("built-in project refuses a non-empty target without a marker and changes nothing", (t) => {
  const fixture = builtinProjectFixture(t);
  const [definition] = loadBuiltinProjectDefinitions(fixture.sourceRoot);
  const targetsRoot = tempDir(t, "task-handoff-builtin-conflict-");
  const targetDir = path.join(targetsRoot, "assistant");
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, "user-file.txt"), "keep me\n");

  assert.throws(() => ensureBuiltinProjectMaterialized(definition, targetDir), { code: "BUILTIN_PROJECT_TARGET_NOT_EMPTY" });
  assert.deepEqual(fs.readdirSync(targetDir), ["user-file.txt"]);
  assert.equal(fs.readFileSync(path.join(targetDir, "user-file.txt"), "utf8"), "keep me\n");
  assert.equal(fs.existsSync(path.join(targetDir, BUILTIN_PROJECT_MARKER_DIR)), false);
});

test("built-in project fills an existing empty target directory", (t) => {
  const fixture = builtinProjectFixture(t);
  const [definition] = loadBuiltinProjectDefinitions(fixture.sourceRoot);
  const targetsRoot = tempDir(t, "task-handoff-builtin-empty-");
  const targetDir = path.join(targetsRoot, "assistant");
  fs.mkdirSync(targetDir);

  const result = ensureBuiltinProjectMaterialized(definition, targetDir);
  assert.equal(result.status, "initialized");
  assert.ok(fs.existsSync(path.join(targetDir, BUILTIN_PROJECT_MARKER_DIR, BUILTIN_PROJECT_MARKER_FILE)));
});

test("projection materializes local projects, skips non-local runtimes and is stable across restarts", (t) => {
  const fixture = builtinProjectFixture(t);
  const definitions = loadBuiltinProjectDefinitions(fixture.sourceRoot);

  // A runtime that cannot host a host-directory project is never materialized.
  const dockerTargets = tempDir(t, "task-handoff-builtin-docker-");
  const dockerProjection = createBuiltinProjectFolderProjection({
    definitions: definitions.map((definition) => ({ ...definition, runtimes: ["docker"] })),
    targetsDir: dockerTargets,
    nodeId: "node_one",
  });
  assert.deepEqual(dockerProjection.prepare(), []);
  assert.deepEqual(dockerProjection.list(), []);
  assert.equal(fs.readdirSync(dockerTargets).length, 0);

  const targetsRoot = tempDir(t, "task-handoff-builtin-provision-");
  const projection = createBuiltinProjectFolderProjection({ definitions, targetsDir: targetsRoot, nodeId: "node_one" });
  const first = projection.prepare();
  assert.deepEqual(first.map((outcome) => outcome.status), ["initialized"]);
  assert.equal(first[0].filesWritten, definitions[0].files.length);

  const [folder] = projection.list();
  assert.equal(folder.id, builtinProjectFolderId("assistant"));
  assert.equal(folder.origin, "builtin");
  assert.equal(folder.name, definitions[0].name);
  assert.equal(folder.path, path.join(targetsRoot, "assistant"));
  assert.equal(projection.owns(folder.id), true);
  assert.equal(projection.get(folder.id).path, folder.path);

  const again = projection.prepare();
  assert.deepEqual(again.map((outcome) => outcome.status), ["already-initialized"]);
  assert.equal(projection.list().length, 1);
});

test("projection reports a conflict instead of overwriting an operator directory", (t) => {
  const fixture = builtinProjectFixture(t);
  const definitions = loadBuiltinProjectDefinitions(fixture.sourceRoot);
  const targetsRoot = tempDir(t, "task-handoff-builtin-provision-conflict-");
  fs.mkdirSync(path.join(targetsRoot, "assistant"));
  fs.writeFileSync(path.join(targetsRoot, "assistant", "notes.md"), "mine\n");
  const projection = createBuiltinProjectFolderProjection({ definitions, targetsDir: targetsRoot, nodeId: "node_one" });
  const outcomes = projection.prepare();
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["failed"]);
  assert.equal(outcomes[0].code, "BUILTIN_PROJECT_TARGET_NOT_EMPTY");
  assert.deepEqual(fs.readdirSync(path.join(targetsRoot, "assistant")), ["notes.md"]);
  // A directory this product did not initialize is not offered as a project.
  assert.deepEqual(projection.list(), []);
});

test("node agent projects built-in folders without persisting them", async (t) => {
  if (process.platform === "win32") return t.skip("Local Runtime is unavailable on Windows");
  const dataDir = tempDir(t, "task-handoff-builtin-upgrade-");
  const workspace = tempDir(t, "task-handoff-builtin-workspace-");
  const fixture = builtinProjectFixture(t);
  const options = { dataDir, logger: false, nodeId: "node_builtin_upgrade", builtinProjectsDir: fixture.sourceRoot };
  let app = await createNodeAgentApp(options);
  try {
    app.nodeAgentState.createInstance({
      id: "inst_existing_builtin", name: "Existing local instance",
      runtimeId: "runtime_local_host", source: { type: "local-folder", path: workspace },
      sourceSnapshot: {}, modelSelection: {},
    });
    // The persisted operator set is the authority for user folders; a built-in
    // project is derived from the shipped catalog and the marker on disk, so it
    // must never appear there.
    assert.equal(app.nodeAgentState.localFolders.list().length, 0);
    const folder = app.nodeAgentState.listLocalFolders().find((item) => item.origin === "builtin");
    assert.ok(folder);
    assert.equal(folder.name, "Assistant");
    assert.equal(folder.localizedNames?.["zh-CN"], "助理");
    assert.equal(readBuiltinProjectMarker(folder.path).projectId, "assistant");
    const skillPath = path.join(folder.path, ".agents", "skills", "taskhandoff", "SKILL.md");
    fs.writeFileSync(skillPath, "operator edit\n");

    await app.close();
    app = await createNodeAgentApp(options);
    assert.equal(app.nodeAgentState.localFolders.list().length, 0, "built-in folders must never be persisted");
    assert.equal(app.nodeAgentState.listLocalFolders().filter((item) => item.origin === "builtin").length, 1);
    assert.equal(fs.readFileSync(skillPath, "utf8"), "operator edit\n");
  } finally {
    await app.close();
  }
});

test("node agent owns built-in folders: rename and delete are refused", (t) => {
  const fixture = builtinProjectFixture(t);
  const definitions = loadBuiltinProjectDefinitions(fixture.sourceRoot);
  const dataDir = tempDir(t, "task-handoff-builtin-state-");
  const targetsDir = path.join(dataDir, "builtin-projects");
  const state = new NodeAgentState(nodeAgentStorePaths(dataDir), "node_one", "http://127.0.0.1:8091", "http://host.docker.internal:8091", 8091);
  state.init();

  const projection = createBuiltinProjectFolderProjection({ definitions, targetsDir, nodeId: "node_one" });
  projection.prepare();
  state.attachBuiltinProjectFolders(projection);

  const folder = state.listLocalFolders().find((item) => item.origin === "builtin");
  assert.ok(folder);
  assert.equal(folder.name, definitions[0].name);
  assert.equal(state.localFolders.list().length, 0, "derived built-in folders never enter the operator table");
  assert.equal(state.resolveLocalFolder(folder.id).path, folder.path);
  assert.throws(() => state.updateLocalFolder(folder.id, { name: "renamed" }), { code: "NODE_LOCAL_FOLDER_BUILTIN_READONLY", statusCode: 409 });
  assert.throws(() => state.deleteLocalFolder(folder.id), { code: "NODE_LOCAL_FOLDER_BUILTIN_READONLY", statusCode: 409 });
  assert.equal(state.resolveLocalFolder(folder.id).name, definitions[0].name);

  // Unknown ids keep the existing not-found contract for both mutations.
  assert.throws(() => state.updateLocalFolder("folder_missing", { name: "x" }), { code: "NODE_LOCAL_FOLDER_NOT_FOUND", statusCode: 404 });
  assert.equal(state.deleteLocalFolder("folder_missing"), false);

  const operator = state.createLocalFolder({ name: "Workspace", path: dataDir, labels: {} });
  assert.equal(operator.origin, "user");
  assert.equal(state.updateLocalFolder(operator.id, { name: "Renamed" }).name, "Renamed");
  assert.equal(state.deleteLocalFolder(operator.id), true);
});

test("local folder origin is additive: absent means user, invalid values are dropped", () => {
  const base = { id: "folder_one", nodeId: "node_one", name: "Project", path: "/tmp/project", labels: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(NodeLocalFolderSchema.parse(base).origin, "user");
  assert.equal(NodeLocalFolderSchema.parse({ ...base, origin: "builtin" }).origin, "builtin");
  assert.equal(NodeLocalFolderSchema.parse(sanitizeStoredNodeLocalFolder({ ...base, origin: "nonsense" })).origin, "user");
  assert.equal(sanitizeStoredNodeLocalFolder({ ...base, origin: "nonsense" }).origin, undefined);
});
