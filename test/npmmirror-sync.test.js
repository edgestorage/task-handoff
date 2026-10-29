const assert = require("node:assert/strict");
const test = require("node:test");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("npmmirror sync queues every package and verifies the exact release", async () => {
  const { syncNpmmirror } = await import("../scripts/sync-npmmirror.mjs");
  const registry = "https://registry.npmmirror.com";
  const packages = ["@task-handoff/node-agent", "@task-handoff/controlled-instance"];
  const version = "0.0.46";
  const statusCalls = new Map();

  const fetchImpl = async (url, init = {}) => {
    if (init.method === "PUT" && url.endsWith("/syncs")) {
      return response(201, { ok: true, id: `task-${url.split("/").at(-2)}`, state: "waiting" });
    }
    if (url.includes("/-/package/") && url.includes("/syncs/")) {
      const taskId = url.split("/").at(-1);
      const calls = (statusCalls.get(taskId) || 0) + 1;
      statusCalls.set(taskId, calls);
      return response(200, { ok: true, state: calls === 1 ? "waiting" : "success" });
    }
    if (url === `${registry}/${packages[0]}` || url === `${registry}/${packages[1]}`) {
      return response(200, { versions: { [version]: {} }, "dist-tags": { latest: version } });
    }
    if (url.endsWith(`-${version}.tgz`) && init.method === "HEAD") return response(200, "");
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  };

  const result = await syncNpmmirror({
    version,
    packages,
    registry,
    distTag: "latest",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => [item.packageName, item.state, item.verified]), [
    [packages[0], "success", true],
    [packages[1], "success", true],
  ]);
  assert.deepEqual([...statusCalls.values()], [2, 2]);
});

test("npmmirror sync reports partial failures without throwing", async () => {
  const { syncNpmmirror } = await import("../scripts/sync-npmmirror.mjs");
  const registry = "https://registry.npmmirror.com";
  const version = "0.0.46";
  const packages = ["@task-handoff/node-agent", "@task-handoff/controlled-instance"];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "PUT" && url.includes("@task-handoff/node-agent")) {
      return response(503, { error: "mirror unavailable" });
    }
    if (init.method === "PUT" && url.endsWith("/syncs")) {
      return response(201, { ok: true, id: "task-controlled-instance", state: "waiting" });
    }
    if (url.includes("/syncs/task-controlled-instance")) return response(200, { state: "success" });
    if (url === `${registry}/${packages[1]}`) {
      return response(200, { versions: { [version]: {} }, "dist-tags": { latest: version } });
    }
    if (url.endsWith(`-${version}.tgz`) && init.method === "HEAD") return response(200, "");
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  };

  const result = await syncNpmmirror({
    version,
    packages,
    registry,
    distTag: "latest",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].state, "failed");
  assert.match(result.results[0].error, /HTTP 503/);
  assert.equal(result.results[1].state, "success");
  assert.equal(result.results[1].verified, true);
});
