const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../../..");
const cliPath = path.join(root, "apps/cli/src/runtime/node-agent.ts");
const loaderUrl = pathToFileURL(path.join(root, "test/support/ts-esm-loader.mjs")).href;
const timestamp = "2026-10-29T01:00:00.000Z";

const impact = {
  runningInstanceCount: 1,
  stoppedInstanceCount: 1,
  activeInstanceCount: 1,
  restartInstanceCount: 1,
  runningInstanceIds: ["ins_0000000000001"],
  stoppedInstanceIds: ["ins_0000000000002"],
  activeInstanceIds: ["ins_0000000000001"],
};

function checkResult(overrides = {}) {
  return {
    source: "npm",
    channel: "stable",
    currentVersion: "1.2.3",
    availableVersion: "1.3.0",
    artifactRef: "npm:@task-handoff/node-agent@1.3.0#sha512-abc",
    runtimeArtifacts: [],
    impact,
    updateAvailable: true,
    supported: true,
    checkedAt: timestamp,
    preflightToken: "preflight-token-1234",
    ...overrides,
  };
}

function updateJob(overrides = {}) {
  return {
    id: "update_0000000000001",
    nodeId: "nod_0000000000001",
    source: "npm",
    channel: "stable",
    fromVersion: "1.2.3",
    toVersion: "1.3.0",
    artifactRef: "npm:@task-handoff/node-agent@1.3.0#sha512-abc",
    runtimeArtifacts: [],
    impact,
    rollout: {
      phase: "queued",
      desiredVersion: "1.3.0",
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function withMockNodeAgent(handler, run) {
  const calls = [];
  const server = http.createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const call = {
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    };
    calls.push(call);
    const result = await handler(call, calls);
    response.writeHead(result.status || 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await run({ endpoint: `http://127.0.0.1:${address.port}`, calls });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

function runCli(endpoint, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      loaderUrl,
      cliPath,
      ...args,
      "--endpoint",
      endpoint,
      "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        TASK_HANDOFF_NODE_AGENT_TOKEN: "local-token",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("node-agent update --check reports the selected release channel", async () => {
  const check = checkResult({ channel: "beta" });
  await withMockNodeAgent(() => ({ body: { data: check } }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["update", "--check", "--channel", "beta"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "/api/node-agent/updates/check"],
    ]);
    assert.equal(calls[0].authorization, "Bearer local-token");
    assert.deepEqual(calls[0].body, { channel: "beta" });
    assert.equal(JSON.parse(result.stdout).availableVersion, "1.3.0");
  });
});

test("node-agent update applies the preflight target and can return after queuing", async () => {
  const check = checkResult();
  const queued = updateJob({ status: "updating-node" });
  await withMockNodeAgent((call) => ({
    body: { data: call.url.endsWith("/check") ? check : queued },
  }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["update", "--yes", "--no-wait"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "/api/node-agent/updates/check"],
      ["POST", "/api/node-agent/updates/apply"],
    ]);
    assert.deepEqual(calls[1].body, {
      channel: "stable",
      targetVersion: "1.3.0",
      preflightToken: "preflight-token-1234",
    });
    assert.equal(JSON.parse(result.stdout).id, "update_0000000000001");
  });
});

test("node-agent update waits through the service restart for the terminal job", async () => {
  const check = checkResult();
  const queued = updateJob({ status: "restarting-node" });
  const completed = updateJob({ status: "succeeded", completedAt: timestamp });
  await withMockNodeAgent((call) => ({
    body: {
      data: call.url.endsWith("/check")
        ? check
        : call.url.endsWith("/apply")
          ? queued
          : [completed],
    },
  }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["update", "--yes", "--timeout", "5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "/api/node-agent/updates/check"],
      ["POST", "/api/node-agent/updates/apply"],
      ["GET", "/api/node-agent/updates/jobs"],
    ]);
    assert.equal(JSON.parse(result.stdout).status, "succeeded");
  });
});

test("node-agent update requires --yes for non-interactive execution", async () => {
  await withMockNodeAgent(() => ({ body: { data: checkResult() } }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["update", "--no-wait"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use --yes/);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["POST", "/api/node-agent/updates/check"],
    ]);
  });
});
