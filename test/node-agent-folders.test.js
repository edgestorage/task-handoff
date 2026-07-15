const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { filesystemRoots, listFolderTree, MAX_FOLDER_TREE_CHILDREN } = require("../packages/control-plane/src/node-agent/folders.ts");

test("folder picker starts at filesystem roots", () => {
  const roots = filesystemRoots();

  assert.ok(roots.length > 0);
  assert.ok(roots.every((root) => path.parse(root).root === root));
  assert.deepEqual(listFolderTree({ depth: 0 }).map((entry) => entry.path), roots.map((root) => path.resolve(root)));
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
