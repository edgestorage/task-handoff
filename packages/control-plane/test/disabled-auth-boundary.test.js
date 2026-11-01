import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createControlPlaneApp } from "../src/control-plane/http/server.ts";

test("disabled authentication keeps local trust while rejecting invalid and remote credentials", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "disabled-auth-boundary-"));
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-control-plane-ui"),
    auth: { mode: "disabled" },
    cloudConnectivityEnabled: false,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const local = await app.inject({ method: "GET", url: "/api/nodes", remoteAddress: "127.0.0.1" });
  assert.equal(local.statusCode, 200, local.body);

  const remote = await app.inject({ method: "GET", url: "/api/nodes", remoteAddress: "203.0.113.10" });
  assert.equal(remote.statusCode, 401, remote.body);
  assert.equal(remote.json().error.code, "CONTROL_PLANE_AUTH_REQUIRED");

  for (const headers of [
    { authorization: "Bearer not-a-session.token" },
    { authorization: "Basic dXNlcjpwYXNz" },
    { cookie: "task_handoff_cp_session=not-a-session.token" },
  ]) {
    const rejected = await app.inject({
      method: "GET",
      url: "/api/nodes",
      headers,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(rejected.statusCode, 401, `${JSON.stringify(headers)}: ${rejected.body}`);
    assert.equal(rejected.json().error.code, "CONTROL_PLANE_AUTH_REQUIRED");
  }

  const session = await app.inject({
    method: "POST",
    url: "/api/auth/cli/local",
    payload: { client: { name: "boundary-test", platform: "darwin" } },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(session.statusCode, 200, session.body);
  const authenticated = await app.inject({
    method: "GET",
    url: "/api/nodes",
    headers: { authorization: `Bearer ${session.json().data.sessionToken}` },
    remoteAddress: "203.0.113.10",
  });
  assert.equal(authenticated.statusCode, 200, authenticated.body);

  const anonymousSession = await app.inject({ method: "GET", url: "/api/auth/session", remoteAddress: "203.0.113.10" });
  assert.equal(anonymousSession.statusCode, 200, anonymousSession.body);
  assert.equal(anonymousSession.json().data.authenticated, false);
  const invalidSession = await app.inject({
    method: "GET",
    url: "/api/auth/session",
    headers: { authorization: "Bearer not-a-session.token" },
  });
  assert.equal(invalidSession.statusCode, 200, invalidSession.body);
  assert.equal(invalidSession.json().data.authenticated, false);
  const health = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
  assert.equal(health.statusCode, 200, health.body);
});
