const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
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

function runCli(endpoint, args, { json = true, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      loaderUrl,
      cliPath,
      ...args,
      "--endpoint",
      endpoint,
      ...(json ? ["--json"] : []),
    ], {
      cwd: root,
      env: {
        ...process.env,
        TASK_HANDOFF_NODE_AGENT_TOKEN: "local-token",
        ...env,
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
    assert.deepEqual(JSON.parse(result.stdout), snapshot());
  });
});

function pairing(id, name, overrides = {}) {
  return { id, name, keyId: `key_${id}`, pairedAt: requestedAt, updatedAt: lastSeenAt, current: false, ...overrides };
}

function humanSnapshot(call, trust = snapshot(), pairings = [pairing("cp_alpha", "团队控制面板")]) {
  if (call.url === "/api/node-agent/health") {
    return { body: { data: { nodeId: "node_a", hostname: "Debian 开发机", futureField: true } } };
  }
  if (call.url === "/api/node-agent/control-plane-pairings") return { body: { data: pairings } };
  return { body: { data: trust } };
}

test("trust human output uses authoritative names and hides diagnostic IDs", async () => {
  await withMockNodeAgent((call) => humanSnapshot(call), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["trust", "list"], { json: false });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Node\s+Debian 开发机/);
    assert.match(result.stdout, /Pending · 1/);
    assert.match(result.stdout, /团队控制面板 · First connection/);
    assert.match(result.stdout, /Trusted · 1/);
    assert.match(result.stdout, /团队控制面板 · Trusted/);
    assert.match(result.stdout, /Verify code\s+ABCD-EFGH-JKMN-PQRS/);
    assert.match(result.stdout, /Expires\s+2026-10-27 01:00 UTC/);
    assert.match(result.stdout, /trust approve nctr_request_a \\\n\s+--comparison-code ABCD-EFGH-JKMN-PQRS --revision 2 \\\n\s+--endpoint/);
    for (const hidden of ["node_a", "node_handle_a", "cp_alpha", "nrb_binding_a", "account_owner", "ncp_pin_a", fingerprint, "local-token"]) {
      assert.ok(!result.stdout.includes(hidden), hidden);
    }
    assert.ok(!result.stdout.includes("\x1b["));
    assert.deepEqual(calls.map((call) => call.url).sort(), [
      "/api/node-agent/control-plane-pairings", "/api/node-agent/control-plane-trust", "/api/node-agent/health",
    ]);
    assert.ok(calls.every((call) => call.authorization === "Bearer local-token"));
  });
});

test("trust verbose keeps complete audit data and revocation commands", async () => {
  await withMockNodeAgent((call) => humanSnapshot(call), async ({ endpoint }) => {
    const result = await runCli(endpoint, ["trust", "list", "--verbose"], { json: false });
    assert.equal(result.status, 0, result.stderr);
    for (const detail of ["node_a", "node_handle_a", "cp_alpha", "nrb_binding_a", "account_owner", "ncp_pin_a", fingerprint, requestedAt, lastSeenAt, expiresAt, "local:local-node-agent-admin"]) {
      assert.ok(result.stdout.includes(detail), detail);
    }
    assert.match(result.stdout, /trust revoke ncp_pin_a/);
    assert.match(result.stdout, /--comparison-code ABCD-EFGH-JKMN-PQRS --revision 1/);
  });
});

test("trust uses the latest nonempty pairing name and disambiguates duplicate names", async () => {
  const data = snapshot({ requests: [request()], pins: [pin("active", { controlPlaneId: "cp_beta" })] });
  const pairings = [
    pairing("cp_alpha", "Outdated", { updatedAt: requestedAt }),
    pairing("cp_alpha", "Same name"),
    pairing("cp_beta", "Same name"),
  ];
  await withMockNodeAgent((call) => humanSnapshot(call, data, pairings), async ({ endpoint }) => {
    const result = await runCli(endpoint, ["trust", "list"], { json: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Same name \(…_alpha\) · First connection/);
    assert.match(result.stdout, /Same name \(…p_beta\) · Trusted/);
    assert.ok(!result.stdout.includes("Outdated"));
  });
});

test("v0.0.46 trust snapshots with missing names still render and approve with exact identities", async () => {
  await withMockNodeAgent((call) => humanSnapshot(call, snapshot(), []), async ({ endpoint, calls }) => {
    const result = await runCli(endpoint, ["trust", "list"], { json: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Unnamed Control Plane \(…_alpha\)/);
    const approved = await runCli(endpoint, ["trust", "approve", "nctr_request_a", "--comparison-code", comparisonCode], { json: false });
    assert.equal(approved.status, 0, approved.stderr);
    assert.deepEqual(calls.find((call) => call.method === "POST").body, {
      action: "approve", expectedFingerprint: fingerprint, expectedRevision: 2,
    });
  });
});

test("optional name lookup errors do not hide the trust snapshot or fail a successful decision", async () => {
  await withMockNodeAgent((call) => call.url.endsWith("/health") || call.url.endsWith("/control-plane-pairings")
    ? { status: 503, body: { error: { message: "Unavailable" } } }
    : { body: { data: call.method === "POST" ? snapshot({ requests: [] }) : snapshot() } }, async ({ endpoint }) => {
    const result = await runCli(endpoint, ["trust", "approve", "nctr_request_a", "--comparison-code", comparisonCode], { json: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pending · 0/);
    assert.match(result.stdout, /No pending requests/);
    assert.match(result.stdout, /Trusted · 1/);
    assert.match(result.stderr, /Could not load node names/);
    assert.match(result.stderr, /Could not load Control Plane names/);
  });
});

test("a stalled name lookup times out while retaining the other endpoint's name", { timeout: 10_000 }, async () => {
  await withMockNodeAgent((call) => call.url.endsWith("/control-plane-pairings")
    ? new Promise(() => {}) : humanSnapshot(call), async ({ endpoint }) => {
    const result = await runCli(endpoint, ["trust", "list"], { json: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node\s+Debian 开发机/);
    assert.match(result.stdout, /Unnamed Control Plane/);
    assert.match(result.stdout, /Verify code\s+ABCD-EFGH-JKMN-PQRS/);
    assert.match(result.stderr, /Could not load Control Plane names/);
  });
});

test("trust output sanitizes remote names and renders explicit empty states", async () => {
  await withMockNodeAgent((call) => humanSnapshot(call, snapshot({ pins: [] }), [pairing("cp_alpha", "Team\x1b[31m\nControl Plane")]), async ({ endpoint }) => {
    const result = await runCli(endpoint, ["trust", "list"], { json: false, env: { NO_COLOR: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Team Control Plane · First connection/);
    assert.match(result.stdout, /Trusted · 0/);
    assert.match(result.stdout, /No trusted Control Planes/);
    assert.ok(!result.stdout.includes("\x1b"));
  });
});

test("trust formatter preserves verification data across terminal layouts", async (t) => {
  await import(loaderUrl);
  const { renderTrustSnapshot } = await import(pathToFileURL(path.join(root, "apps/cli/src/runtime/node-agent-trust-output.ts")).href);
  const names = { nodeName: "开发机", controlPlanes: new Map([["cp_alpha", "团队控制面板"]]) };

  await t.test("narrow terminals keep complete IDs and put long fields on a separate line", () => {
    const output = renderTrustSnapshot(snapshot(), { names, verbose: true, columns: 32 });
    assert.match(output, /  Verify code\n    ABCD-EFGH-JKMN-PQRS/);
    assert.match(output, /  Fingerprint\n    sha256:A{43}/);
    assert.ok(output.includes("nctr_request_a"));
    assert.ok(output.includes("ncp_pin_a"));
    assert.ok(output.split("\n").filter((line) => line.startsWith("─")).every((line) => line.length === 32));
  });

  await t.test("colliding short IDs expand enough to distinguish same-name peers", () => {
    const first = "cp_aaaa123456";
    const second = "cp_bbbb123456";
    const output = renderTrustSnapshot(snapshot({
      requests: [request("pending", { controlPlaneId: first })],
      pins: [pin("active", { controlPlaneId: second })],
    }), { names: { controlPlanes: new Map([[first, "Team"], [second, "Team"]]) } });
    assert.match(output, /Team \(…a123456\)/);
    assert.match(output, /Team \(…b123456\)/);
  });

  await t.test("historical records do not appear as pending or trusted", () => {
    const output = renderTrustSnapshot(snapshot({ requests: [request("expired")], pins: [pin("revoked")] }), { names });
    assert.match(output, /Pending · 0/);
    assert.match(output, /Trusted · 0/);
    assert.ok(!output.includes(comparisonCode));
    assert.ok(!output.includes("trust approve"));
  });

  await t.test("colors preserve the same readable text", () => {
    const { stripVTControlCharacters } = require("node:util");
    const plain = renderTrustSnapshot(snapshot(), { names });
    const colored = renderTrustSnapshot(snapshot(), { names, color: true });
    assert.ok(colored.includes("\x1b["));
    assert.equal(stripVTControlCharacters(colored), plain);
  });

  await t.test("copyable commands quote opaque IDs and transport paths without shell evaluation", () => {
    const opaqueId = "request'$(printf INJECTED)";
    const ipcPath = "/tmp/agent's socket $(printf WRONG).sock";
    const output = renderTrustSnapshot(snapshot({ requests: [request("pending", { requestId: opaqueId })], pins: [] }), {
      names, transportArgs: ["--ipc-path", ipcPath],
    });
    const commandLines = output.split("\n");
    const firstLine = commandLines.findIndex((line) => line.startsWith("    task-handoff-node-agent "));
    const command = commandLines.slice(firstLine, commandLines.indexOf("", firstLine)).join("\n");
    const echoed = spawnSync("sh", ["-c", command.replace("task-handoff-node-agent", "printf '%s\\n'")], { encoding: "utf8" });
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.deepEqual(echoed.stdout.trimEnd().split("\n"), [
      "trust", "approve", opaqueId, "--comparison-code", comparisonCode, "--revision", "2", "--ipc-path", ipcPath,
    ]);
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
