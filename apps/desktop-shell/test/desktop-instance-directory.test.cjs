const assert = require("node:assert/strict");
const test = require("node:test");
const { loadDesktopInstanceDirectory } = require("../src/desktop-instance-directory.cjs");

function response(data, options = {}) {
  return { ok: options.ok ?? true, status: options.status ?? 200, json: async () => ({ data }) };
}

test("desktop instance directory groups the authoritative instance projection by node", async () => {
  const requested = [];
  const groups = await loadDesktopInstanceDirectory({
    endpoint: "http://127.0.0.1:18081/",
    fetch: async (url) => {
      requested.push(url);
      return url.includes("/api/nodes")
        ? response([{ id: "node-b", name: "Node B", ignored: true }, { id: "node-a", name: "Node A" }])
        : response([
            { id: "instance-z", name: "Zulu", nodeId: "node-a", ignored: true },
            { id: "instance-a", name: "Alpha", nodeId: "node-a" },
            { id: "instance-b", name: "Beta", nodeId: "node-b" },
          ]);
    },
  });
  assert.deepEqual(requested.sort(), [
    "http://127.0.0.1:18081/api/instance-board?projection=directory",
    "http://127.0.0.1:18081/api/nodes?projection=directory",
  ]);
  assert.deepEqual(groups, [
    { nodeId: "node-b", nodeName: "Node B", instances: [{ id: "instance-b", name: "Beta" }] },
    { nodeId: "node-a", nodeName: "Node A", instances: [{ id: "instance-a", name: "Alpha" }, { id: "instance-z", name: "Zulu" }] },
  ]);
});

test("desktop instance directory fails closed for malformed or unauthorized snapshots", async () => {
  await assert.rejects(() => loadDesktopInstanceDirectory({
    endpoint: "http://127.0.0.1:18081",
    fetch: async (url) => url.includes("/api/nodes") ? response([]) : response([], { ok: false, status: 401 }),
  }), /HTTP 401/);
  await assert.rejects(() => loadDesktopInstanceDirectory({
    endpoint: "http://127.0.0.1:18081",
    fetch: async (url) => url.includes("/api/nodes") ? response([{ id: "node-a", name: "Node A" }]) : response([{ id: "instance-a", nodeId: "node-a" }]),
  }), /instance\.name/);
});

test("desktop instance directory falls back when an older control plane rejects projections", async () => {
  const requested = [];
  const groups = await loadDesktopInstanceDirectory({
    endpoint: "http://127.0.0.1:18081",
    fetch: async (url) => {
      requested.push(url);
      if (url.includes("projection=directory")) return response([], { ok: false, status: 400 });
      return url.endsWith("/api/nodes")
        ? response([{ id: "node-a", name: "Node A" }])
        : response([{ id: "instance-a", name: "Alpha", nodeId: "node-a" }]);
    },
  });
  assert.deepEqual(requested.sort(), [
    "http://127.0.0.1:18081/api/instance-board",
    "http://127.0.0.1:18081/api/instance-board?projection=directory",
    "http://127.0.0.1:18081/api/nodes",
    "http://127.0.0.1:18081/api/nodes?projection=directory",
  ]);
  assert.deepEqual(groups, [{ nodeId: "node-a", nodeName: "Node A", instances: [{ id: "instance-a", name: "Alpha" }] }]);
});
