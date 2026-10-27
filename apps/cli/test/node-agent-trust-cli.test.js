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
const fingerprint = `sha256:${"A".repeat(43)}`;
const comparisonCode = "ABCD-EFGH-JKMN-PQRS";
const requestedAt = "2026-10-26T01:00:00.000Z";
const lastSeenAt = "2026-10-26T01:01:00.000Z";
const expiresAt = "2026-10-27T01:00:00.000Z";

function request(status = "pending", overrides = {}) {
  return {
    requestId: "nctr_request_a",
    status,
    reason: "first-seen",
    controlPlaneId: "cp_alpha",
    fingerprint,
    comparisonCode,
    nodeHandle: "node_handle_a",
    bindingId: "nrb_binding_a",
    bindingRevision: 3,
    access: {
      accountId: "account_owner",
      ownerAccountId: "account_owner",
      accessMode: "owner",
    },
    requestedAt,
    lastSeenAt,
    expiresAt,
    revision: 2,
    ...overrides,
  };
}

function pin(status = "active", overrides = {}) {
  return {
    pinId: "ncp_pin_a",
    status,
    controlPlaneId: "cp_alpha",
    fingerprint,
    comparisonCode,
    nodeHandle: "node_handle_a",
    bindingId: "nrb_binding_a",
    bindingRevision: 3,
    access: {
      accountId: "account_owner",
      ownerAccountId: "account_owner",
      accessMode: "owner",
    },
    approvedAt: "2026-10-26T01:02:00.000Z",
    approvedByActorType: "local",
    approvedByActorId: "local-node-agent-admin",
    lastSeenAt,
    revision: 1,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    nodeId: "node_a",
    nodeHandle: "node_handle_a",
    requests: [request()],
    pins: [pin()],
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

test("node-agent trust list reads and prints the authenticated snapshot", async () => {
  await withMockNodeAgent(() => ({ body: { data: snapshot() } }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["trust", "list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [["GET", "/api/node-agent/control-plane-trust"]]);
    assert.equal(calls[0].authorization, "Bearer local-token");
    assert.equal(JSON.parse(result.stdout).requests[0].requestId, "nctr_request_a");
  });
});

test("node-agent trust approve forwards the reviewed fingerprint, revision, and key retention", async () => {
  const approved = snapshot({
    requests: [request("approved", { pinId: "ncp_pin_a" })],
  });
  await withMockNodeAgent((call) => ({
    body: { data: call.method === "POST" ? approved : snapshot() },
  }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, [
      "trust", "approve", "nctr_request_a",
      "--fingerprint", fingerprint,
      "--revision", "4",
      "--retain-previous-key",
      "--reason", "verified in the Control Plane",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls.map((call) => [call.method, call.url]), [
      ["GET", "/api/node-agent/control-plane-trust"],
      ["POST", "/api/node-agent/control-plane-trust/requests/nctr_request_a/decision"],
    ]);
    assert.deepEqual(calls[1].body, {
      action: "approve",
      expectedFingerprint: fingerprint,
      expectedRevision: 4,
      retainPreviousKey: true,
      reason: "verified in the Control Plane",
    });
    assert.equal(JSON.parse(result.stdout).requests[0].status, "approved");
  });
});

test("node-agent trust reject and revoke use exact identities", async () => {
  const rejected = snapshot({ requests: [request("rejected")] });
  const revoked = snapshot({ pins: [pin("revoked")] });
  await withMockNodeAgent((call) => ({
    body: {
      data: call.url.endsWith("/revoke") ? revoked : rejected,
    },
  }), async ({ endpoint, calls }) => {
    const rejectedResult = await runCli(endpoint, [
      "trust", "reject", "nctr_request_a",
      "--comparison-code", comparisonCode,
      "--reason", "wrong account",
    ]);
    assert.equal(rejectedResult.status, 0, rejectedResult.stderr);
    assert.deepEqual(calls[1].body, {
      action: "reject",
      expectedFingerprint: fingerprint,
      expectedRevision: 2,
      reason: "wrong account",
    });

    const revokedResult = await runCli(endpoint, [
      "trust", "revoke", "ncp_pin_a",
      "--fingerprint", fingerprint,
      "--reason", "retired Control Plane",
    ]);
    assert.equal(revokedResult.status, 0, revokedResult.stderr);
    assert.deepEqual(calls[3].body, {
      expectedFingerprint: fingerprint,
      expectedRevision: 1,
      reason: "retired Control Plane",
    });
    assert.equal(JSON.parse(revokedResult.stdout).pins[0].status, "revoked");
  });
});

test("node-agent trust retry is limited to rejected or expired requests", async () => {
  const retried = snapshot({ requests: [request("pending", { requestId: "nctr_request_b" })] });
  await withMockNodeAgent((call, calls) => {
    const getCount = calls.filter((item) => item.method === "GET").length;
    return {
      body: {
        data: call.method === "POST" ? retried : snapshot({
          requests: [request(getCount === 1 ? "rejected" : getCount === 2 ? "expired" : "pending")],
        }),
      },
    };
  }, async ({ endpoint, calls }) => {
    const rejectedRetry = await runCli(endpoint, ["trust", "retry", "nctr_request_a", "--fingerprint", fingerprint]);
    assert.equal(rejectedRetry.status, 0, rejectedRetry.stderr);
    assert.deepEqual(calls[1].body, {});

    const expiredRetry = await runCli(endpoint, ["trust", "retry", "nctr_request_a", "--fingerprint", fingerprint]);
    assert.equal(expiredRetry.status, 0, expiredRetry.stderr);
    assert.deepEqual(calls[3].body, {});

    const pendingRetry = await runCli(endpoint, ["trust", "retry", "nctr_request_a", "--fingerprint", fingerprint]);
    assert.notEqual(pendingRetry.status, 0);
    assert.match(pendingRetry.stderr, /Only rejected or expired requests can be retried/);
    assert.equal(calls.length, 5);
  });
});

test("node-agent trust rejects mismatched fingerprints before sending a decision", async () => {
  await withMockNodeAgent(() => ({ body: { data: snapshot() } }), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, [
      "trust", "approve", "nctr_request_a",
      "--fingerprint", `sha256:${"B".repeat(43)}`,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the request/);
    assert.deepEqual(calls.map((call) => call.method), ["GET"]);
  });
});

test("node-agent trust surfaces duplicate-decision errors and malformed snapshots", async () => {
  await withMockNodeAgent((call) => call.method === "POST"
    ? { status: 409, body: { error: { message: "The trust request has already been decided." } } }
    : { body: { data: snapshot() } }, async ({ endpoint }) => {
    const failed = await runCli(endpoint, [
      "trust", "approve", "nctr_request_a",
      "--fingerprint", fingerprint,
    ]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /already been decided/);
  });

  await withMockNodeAgent(() => ({ body: { data: { requests: [] } } }), async ({ endpoint }) => {
    const malformed = await runCli(endpoint, ["trust", "list"]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /did not include a trust snapshot/);
  });
});

test("node-agent trust reports an unreachable local agent", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");

  const result = await runCli(`http://127.0.0.1:${port}`, ["trust", "list"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch failed|ECONNREFUSED/);
});
