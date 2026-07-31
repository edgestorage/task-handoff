import assert from "node:assert/strict";
import test from "node:test";

import {
  isSameOrChildNodePath,
  nativeNodeFolderSelectionResult,
  nodeFolderSelectionMode,
  nodePathName,
  relativeNodePathSegments,
} from "../src/apps/control-plane/nodePath.ts";

test("web local nodes use node browsing when no native picker exists", () => {
  assert.equal(nodeFolderSelectionMode(true, true), "native");
  assert.equal(nodeFolderSelectionMode(true, false), "node");
  assert.equal(nodeFolderSelectionMode(false, true), "node");
});

test("native folder selections cancel cleanly and stay bound to the target node", () => {
  assert.deepEqual(nativeNodeFolderSelectionResult(undefined, "node_local"), { status: "cancelled" });
  assert.deepEqual(nativeNodeFolderSelectionResult({ path: "  " }, "node_local"), { status: "cancelled" });
  assert.deepEqual(nativeNodeFolderSelectionResult({ path: "/tmp/project", ownerNodeId: "node_other" }, "node_local"), { status: "invalid-owner" });
  assert.deepEqual(nativeNodeFolderSelectionResult({ path: " C:\\work\\project ", ownerNodeId: "node_local" }, "node_local"), {
    status: "selected",
    path: "C:\\work\\project",
  });
});

test("node path names support POSIX and Windows separators", () => {
  assert.equal(nodePathName("/Users/me/project/"), "project");
  assert.equal(nodePathName("C:\\Users\\me\\project\\"), "project");
  assert.equal(nodePathName("\\\\server\\share\\project"), "project");
  assert.equal(nodePathName("/"), "/");
});

test("node path containment respects roots, boundaries, and Windows casing", () => {
  assert.equal(isSameOrChildNodePath("/workspace", "/workspace"), true);
  assert.equal(isSameOrChildNodePath("/workspace/project", "/workspace"), true);
  assert.equal(isSameOrChildNodePath("/workspace-other", "/workspace"), false);
  assert.equal(isSameOrChildNodePath("/Users/me", "/"), true);
  assert.equal(isSameOrChildNodePath("C:\\WORKSPACE\\project", "c:\\workspace\\"), true);
  assert.equal(isSameOrChildNodePath("C:\\workspace-other", "C:\\workspace"), false);
  assert.equal(isSameOrChildNodePath("D:\\workspace", "C:\\workspace"), false);
  assert.equal(isSameOrChildNodePath("/workspace", "C:\\workspace"), false);
  assert.equal(isSameOrChildNodePath("\\\\SERVER\\Share\\workspace\\project", "\\\\server\\share\\workspace"), true);
  assert.equal(isSameOrChildNodePath("\\\\server\\other\\workspace", "\\\\server\\share\\workspace"), false);
});

test("node path containment resolves dot segments before comparing paths", () => {
  assert.equal(isSameOrChildNodePath("/workspace/project/../src", "/workspace"), true);
  assert.equal(isSameOrChildNodePath("/workspace/../secret", "/workspace"), false);
  assert.equal(isSameOrChildNodePath("C:\\workspace\\project\\..\\src", "c:\\workspace"), true);
  assert.equal(isSameOrChildNodePath("C:\\workspace\\..\\secret", "c:\\workspace"), false);
  assert.equal(isSameOrChildNodePath("\\\\server\\share\\workspace\\..\\secret", "\\\\server\\share\\workspace"), false);
});

test("relative node paths preserve folder names while enforcing containment", () => {
  assert.deepEqual(relativeNodePathSegments("/Users/me/work", "/Users/me/work/project/src"), ["project", "src"]);
  assert.deepEqual(relativeNodePathSegments("C:\\WORK", "c:\\work\\Project\\src"), ["Project", "src"]);
  assert.deepEqual(relativeNodePathSegments("/workspace", "/workspace/project/../src"), ["src"]);
  assert.equal(relativeNodePathSegments("/workspace", "/workspace-other/project"), undefined);
  assert.equal(relativeNodePathSegments("C:\\workspace", "D:\\workspace\\project"), undefined);
});
