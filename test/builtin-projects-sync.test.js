const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  BUILTIN_PROJECT_CONTENT_DIR,
  BUILTIN_PROJECT_MANIFEST_FILE,
  builtinProjectContentDigest,
  listBuiltinProjectFiles,
  loadBuiltinProjectDefinitions,
} = require("../packages/control-plane/src/node-agent/builtin-projects/assets.ts");

const syncScript = path.resolve(__dirname, "../scripts/sync-builtin-projects.mjs");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runSync(args, enabled) {
  const env = { ...process.env };
  delete env.TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED;
  if (enabled !== undefined) env.TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED = enabled ? "1" : "0";
  return spawnSync(process.execPath, [syncScript, ...args], { encoding: "utf8", env });
}

function writeProject(t, options = {}) {
  const projectsDir = tempDir(t, "task-handoff-builtin-projects-");
  const projectRoot = path.join(projectsDir, options.id || "assistant");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "project.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: options.id || "assistant",
    name: options.name || "Assistant",
    ...(options.localizedNames ? { localizedNames: options.localizedNames } : {}),
    runtimes: options.runtimes || ["local"],
    ...(options.skill ? { skill: options.skill } : {}),
  }, null, 2)}\n`);
  return { projectsDir, projectRoot };
}

function writeSkillSource(t, files = { "SKILL.md": "---\nname: taskhandoff\n---\n", "references/nodes.md": "nodes\n" }) {
  const source = tempDir(t, "task-handoff-skill-source-");
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(source, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return source;
}

test("the sync step ships no built-in project while the feature flag is off", (t) => {
  const { projectsDir, projectRoot } = writeProject(t, { skill: { name: "taskhandoff" } });
  const contentDir = path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR);
  fs.mkdirSync(path.join(contentDir, ".agents", "skills", "taskhandoff"), { recursive: true });
  fs.writeFileSync(path.join(contentDir, ".agents", "skills", "taskhandoff", "SKILL.md"), "---\nname: taskhandoff\n---\n");
  fs.writeFileSync(path.join(projectRoot, BUILTIN_PROJECT_MANIFEST_FILE), "{}\n");

  const result = runSync(["--projects-dir", projectsDir], undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /built-in projects are disabled/);
  assert.equal(fs.existsSync(contentDir), false, "a disabled build must not ship content");
  assert.equal(fs.existsSync(path.join(projectRoot, BUILTIN_PROJECT_MANIFEST_FILE)), false, "a disabled build must not ship a manifest");
  assert.equal(fs.existsSync(path.join(projectRoot, "project.json")), true, "the tracked source declaration is never removed");
});

test("the sync step materializes the published skill and derives the manifest", (t) => {
  const { projectsDir, projectRoot } = writeProject(t, {
    localizedNames: { "en-US": "Assistant", "zh-CN": "助理" },
    skill: { name: "taskhandoff" },
  });
  const skillSource = writeSkillSource(t);

  const result = runSync(["--projects-dir", projectsDir, "--skill-source", skillSource], true);
  assert.equal(result.status, 0, result.stderr);

  const contentDir = path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR);
  assert.equal(
    fs.readFileSync(path.join(contentDir, ".agents", "skills", "taskhandoff", "references", "nodes.md"), "utf8"),
    "nodes\n",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, BUILTIN_PROJECT_MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    id: "assistant",
    name: "Assistant",
    localizedNames: { "en-US": "Assistant", "zh-CN": "助理" },
    runtimes: ["local"],
    contentDigest: builtinProjectContentDigest(listBuiltinProjectFiles(contentDir)),
  });

  // The generated catalog is exactly what the node agent loads at startup.
  const definitions = loadBuiltinProjectDefinitions(projectsDir);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].id, "assistant");
  assert.equal(definitions[0].contentDigest, manifest.contentDigest);
  assert.ok(definitions[0].files.some((file) => file.path === ".agents/skills/taskhandoff/SKILL.md"));
});

test("the sync step keeps committed content for a project that declares no skill", (t) => {
  const { projectsDir, projectRoot } = writeProject(t);
  fs.mkdirSync(path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR, "README.md"), "hand written\n");

  const result = runSync(["--projects-dir", projectsDir], true);
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, BUILTIN_PROJECT_MANIFEST_FILE), "utf8"));
  assert.equal(fs.readFileSync(path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR, "README.md"), "utf8"), "hand written\n");
  assert.equal(manifest.contentDigest, builtinProjectContentDigest(listBuiltinProjectFiles(path.join(projectRoot, BUILTIN_PROJECT_CONTENT_DIR))));
});

test("the sync step refuses a skill target that escapes the content directory", (t) => {
  const { projectsDir } = writeProject(t, { skill: { name: "taskhandoff", targetDir: "../escape" } });
  const skillSource = writeSkillSource(t);

  const result = runSync(["--projects-dir", projectsDir, "--skill-source", skillSource], true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not a safe relative path/);
});

test("the sync step refuses an enabled build without a project declaration", (t) => {
  const projectsDir = tempDir(t, "task-handoff-builtin-empty-projects-");
  const result = runSync(["--projects-dir", projectsDir], true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No built-in project declares a project\.json/);
});
