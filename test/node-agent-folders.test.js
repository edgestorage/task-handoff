const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { filesystemRoots, folderPlaces, listFolderTree, MAX_FOLDER_TREE_CHILDREN, requireBrowsableFolderPath } = require("../packages/control-plane/src/node-agent/folders.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { UpdateLocalFolderSchema } = require("../packages/control-plane/src/node-agent/schemas.ts");
const { NodeAgentState } = require("../packages/control-plane/src/node-agent/state.ts");

test("folder picker starts at filesystem roots", () => {
  const roots = filesystemRoots();

  assert.ok(roots.length > 0);
  assert.ok(roots.every((root) => path.parse(root).root === root));
  assert.deepEqual(listFolderTree({ depth: 0 }).map((entry) => entry.path), roots.map((root) => path.resolve(root)));
});

test("folder picker reports authoritative home and filesystem quick locations", () => {
  const places = folderPlaces();
  assert.ok(places.some((place) => place.kind === "home" && path.isAbsolute(place.path)));
  assert.deepEqual(
    places.filter((place) => place.kind === "root").map((place) => place.path),
    filesystemRoots().map((root) => path.resolve(root)),
  );
});

test("folder picker includes hidden and linked directories while excluding files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-folder-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, ".hidden"));
  fs.mkdirSync(path.join(root, "visible"));
  fs.writeFileSync(path.join(root, "file.txt"), "not a folder");
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "visible"), path.join(root, "directory-link"));
  }

  const [tree] = listFolderTree({ path: root, depth: 1 });
  const names = tree.children.map((entry) => entry.name).sort();

  assert.deepEqual(names, process.platform === "win32"
    ? [".hidden", "visible"]
    : [".hidden", "directory-link", "visible"]);
});

test("folder picker bounds each directory response without letting files consume the directory budget", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-folder-tree-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (let index = 0; index < MAX_FOLDER_TREE_CHILDREN + 5; index += 1) {
    fs.mkdirSync(path.join(root, `folder-${String(index).padStart(3, "0")}`));
    fs.writeFileSync(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), "not a folder");
  }

  const [tree] = listFolderTree({ path: root, depth: 1 });

  assert.equal(tree.children.length, MAX_FOLDER_TREE_CHILDREN);
  assert.ok(tree.children.every((entry) => entry.name.startsWith("folder-")));
});

test("folder paths must resolve to an accessible directory before browsing or registration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-folder-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "file.txt");
  const missingPath = path.join(root, "missing");
  fs.writeFileSync(filePath, "not a folder");

  assert.equal(requireBrowsableFolderPath(root), path.resolve(root));
  assert.throws(() => requireBrowsableFolderPath(missingPath), { code: "NODE_FOLDER_PATH_NOT_FOUND", statusCode: 404 });
  assert.throws(() => requireBrowsableFolderPath(filePath), { code: "NODE_FOLDER_PATH_NOT_DIRECTORY", statusCode: 400 });
  assert.throws(() => listFolderTree({ path: missingPath, depth: 1 }), { code: "NODE_FOLDER_PATH_NOT_FOUND", statusCode: 404 });
  assert.throws(() => listFolderTree({ path: filePath, depth: 1 }), { code: "NODE_FOLDER_PATH_NOT_DIRECTORY", statusCode: 400 });
});

test("node-agent refuses to persist a local folder until its path passes authoritative validation", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-folder-state-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const workspace = path.join(dataDir, "workspace");
  const missing = path.join(dataDir, "missing");
  fs.mkdirSync(workspace);
  const state = new NodeAgentState(
    nodeAgentStorePaths(dataDir),
    "node_one",
    "http://127.0.0.1:8091",
    "http://host.docker.internal:8091",
    8091,
    "linux",
  );
  state.init();

  assert.throws(
    () => state.createLocalFolder({ name: "Missing", path: missing, labels: {} }),
    { code: "NODE_FOLDER_PATH_NOT_FOUND", statusCode: 404 },
  );
  assert.deepEqual(state.localFolders.list(), []);

  const created = state.createLocalFolder({ name: "Workspace", path: workspace, labels: {} });
  assert.equal(created.path, path.resolve(workspace));
  assert.deepEqual(state.localFolders.list().map((folder) => folder.id), [created.id]);

  const renamed = state.updateLocalFolder(created.id, { name: "Customer Portal" });
  assert.equal(renamed.name, "Customer Portal");
  assert.equal(renamed.path, created.path);
  assert.equal(state.localFolders.get(created.id).name, "Customer Portal");
  const reset = state.updateLocalFolder(created.id, { name: "" });
  assert.equal(reset.name, "workspace");
  assert.equal(state.localFolders.get(created.id).name, "workspace");
  assert.throws(() => state.updateLocalFolder("folder_missing", { name: "Missing" }), {
    code: "NODE_LOCAL_FOLDER_NOT_FOUND",
    statusCode: 404,
  });
});

test("local folder name updates accept reset-to-folder-name and cannot mutate the path or image", () => {
  assert.deepEqual(UpdateLocalFolderSchema.parse({ name: "Customer Portal" }), { name: "Customer Portal" });
  assert.deepEqual(UpdateLocalFolderSchema.parse({ name: "" }), { name: "" });
  assert.equal(UpdateLocalFolderSchema.safeParse({ name: "Customer Portal", path: "/other" }).success, false);
  assert.equal(UpdateLocalFolderSchema.safeParse({ name: "Customer Portal", defaultImageSelection: { imageId: "img_other" } }).success, false);
});
