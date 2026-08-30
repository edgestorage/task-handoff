import assert from "node:assert/strict";
import test from "node:test";
import { filterInstanceCwdFolders, selectableInstanceCwdFolders } from "../src/apps/control-plane/shared/instanceCwdFolders.ts";

const folders = [
  { id: "project", name: "Project", path: "/workspace/project" },
  { id: "child", name: "", path: "/workspace/project/packages/client" },
  { id: "other", name: "Other", path: "/workspace/other" },
  { id: "project", name: "Duplicate", path: "/workspace/project" },
];

function instance(runtime, source) {
  return { runtime, source };
}

test("local runtime cwd selection exposes every registered node folder once", () => {
  const result = selectableInstanceCwdFolders(instance({ kind: "local" }, { type: "local-folder", path: "/workspace/project" }), folders);
  assert.deepEqual(result.map((folder) => folder.id), ["project", "child", "other"]);
  assert.equal(result[0].name, "Duplicate");
});

test("container cwd selection stays inside the mounted local-folder source", () => {
  const result = selectableInstanceCwdFolders(instance({ kind: "docker" }, { type: "local-folder", path: "/workspace/project" }), folders);
  assert.deepEqual(result.map((folder) => folder.id), ["project", "child"]);
});

test("container cwd selection has no registered folder override for non-local sources", () => {
  const result = selectableInstanceCwdFolders(instance({ kind: "docker" }, { type: "git-repository", url: "https://example.test/project.git" }), folders);
  assert.deepEqual(result, []);
});

test("cwd folder search matches display names and paths", () => {
  assert.deepEqual(filterInstanceCwdFolders(folders, "client").map((folder) => folder.id), ["child"]);
  assert.deepEqual(filterInstanceCwdFolders(folders, "OTHER").map((folder) => folder.id), ["other"]);
});
