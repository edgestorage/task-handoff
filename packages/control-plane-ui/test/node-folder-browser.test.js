import assert from "node:assert/strict";
import test from "node:test";

import { useNodeFolderBrowser } from "../src/apps/control-plane/useNodeFolderBrowser.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function entry(name, path, children = []) {
  return { name, path, children };
}

test("loads roots and lazily expands the selected folder", async () => {
  const calls = [];
  const browser = useNodeFolderBrowser({
    load: async (nodeId, input) => {
      calls.push([nodeId, input]);
      return input.depth === 0
        ? [entry("root", "/")]
        : [entry("root", "/", [entry("workspace", "/workspace")])];
    },
  });

  await browser.loadRoots("node_a");
  assert.deepEqual(browser.rows.value.map((folder) => folder.path), ["/"]);

  await browser.selectFolder(browser.rows.value[0]);
  assert.equal(browser.selectedPath.value, "/");
  assert.deepEqual(browser.rows.value.map((folder) => folder.path), ["/", "/workspace"]);
  assert.deepEqual(calls, [
    ["node_a", { depth: 0 }],
    ["node_a", { path: "/", depth: 1 }],
  ]);
});

test("clears a root-load error when retry succeeds", async () => {
  let attempts = 0;
  const browser = useNodeFolderBrowser({
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("node unavailable");
      return [entry("workspace", "/workspace")];
    },
  });

  await browser.loadRoots("node_a");
  assert.equal(browser.error.value, "node unavailable");

  await browser.loadRoots("node_a");
  assert.equal(browser.error.value, "");
  assert.deepEqual(browser.rows.value.map((folder) => folder.path), ["/workspace"]);
});

test("ignores stale root and child responses after reset or node changes", async () => {
  const oldRoots = deferred();
  const oldChildren = deferred();
  const browser = useNodeFolderBrowser({
    load: (nodeId, input) => {
      if (nodeId === "node_old" && input.depth === 0) return oldRoots.promise;
      if (nodeId === "node_old") return oldChildren.promise;
      return Promise.resolve([entry("current", "C:\\current")]);
    },
  });

  const staleRootRequest = browser.loadRoots("node_old");
  await browser.loadRoots("node_new");
  oldRoots.resolve([entry("stale", "/stale")]);
  await staleRootRequest;
  assert.deepEqual(browser.rows.value.map((folder) => folder.path), ["C:\\current"]);

  await browser.loadRoots("node_old");
  const staleFolder = browser.rows.value[0];
  const staleChildRequest = browser.selectFolder(staleFolder);
  browser.reset();
  oldChildren.resolve([entry("stale", "/stale", [entry("child", "/stale/child")])]);
  await staleChildRequest;
  assert.deepEqual(browser.rows.value, []);
  assert.equal(browser.selectedPath.value, "");
});

test("directory presentation navigates current folders, breadcrumbs, and parent", async () => {
  const calls = [];
  const browser = useNodeFolderBrowser({
    presentation: "directory",
    load: async (nodeId, input) => {
      calls.push([nodeId, input]);
      if (input.depth === 0) return [entry("root", "/")];
      if (input.path === "/") return [entry("root", "/", [entry("home", "/home")])];
      if (input.path === "/home") return [entry("home", "/home", [entry("coder", "/home/coder")])];
      return [entry("coder", "/home/coder")];
    },
  });

  await browser.loadRoots("node_remote");
  assert.equal(browser.currentPath.value, "/");
  assert.deepEqual(browser.rows.value.map((folder) => folder.path), ["/home"]);

  await browser.selectFolder(browser.rows.value[0]);
  assert.equal(browser.selectedPath.value, "/home");
  assert.deepEqual(browser.breadcrumbs.value, [{ label: "/", path: "/" }, { label: "home", path: "/home" }]);
  assert.equal(browser.canGoUp.value, true);

  await browser.goUp();
  assert.equal(browser.currentPath.value, "/");
  assert.equal(browser.canGoUp.value, false);
  assert.deepEqual(calls, [
    ["node_remote", { depth: 0 }],
    ["node_remote", { path: "/", depth: 1 }],
    ["node_remote", { path: "/home", depth: 1 }],
    ["node_remote", { path: "/", depth: 1 }],
  ]);
});
