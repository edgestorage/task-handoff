import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { startLoopbackCallback } from "../src/login.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function loopbackAvailable() {
  try {
    const probe = await startLoopbackCallback();
    probe.close();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the browser authorization request.");
}

async function prepare() {
  const store = new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-browser-")));
  const fake = createFakeControlPlane({ origin: "http://cp.test" });
  await runCli(["node", "thctl", "profile", "add", "http://cp.test"], { store, streams: capture().streams, fetchImpl: fake.fetchImpl, isTty: false });
  return { store, fake };
}

test("browser login exchanges the loopback callback for a CLI session", async (t) => {
  if (!(await loopbackAvailable())) {
    t.skip("loopback binding is not permitted in this environment");
    return;
  }
  const { store, fake } = await prepare();
  const output = capture();
  const opened = [];
  const login = runCli(["node", "thctl", "login"], {
    store,
    streams: output.streams,
    fetchImpl: fake.fetchImpl,
    isTty: false,
    openUrl: async (url) => {
      opened.push(url);
    },
  });
  await waitFor(() => fake.state.authorizeRequests.length > 0);
  const request = fake.state.authorizeRequests[0];
  assert.equal(request.mode, "browser");
  assert.match(request.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(request.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(request.state, fake.state.lastState);
  await waitFor(() => opened.length > 0);
  assert.match(opened[0], /\/cli\/authorize\?request=cliauth_/);

  const callback = await fetch(`${request.redirectUri}?code=${fake.state.issuedCode}&state=${request.state}`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Authorization complete/);
  assert.equal(await login, 0, output.stderr());
  assert.match(output.stdout(), /Signed in to http:\/\/cp\.test/);
  assert.equal(store.secrets().read("cp.test").sessionToken, fake.state.sessionToken);
  assert.equal(store.get("cp.test").loginMode, "browser");
});

test("browser login discards callbacks whose state does not match", async (t) => {
  if (!(await loopbackAvailable())) {
    t.skip("loopback binding is not permitted in this environment");
    return;
  }
  const { store, fake } = await prepare();
  const output = capture();
  const login = runCli(["node", "thctl", "login"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false, openUrl: async () => {},
  });
  await waitFor(() => fake.state.authorizeRequests.length > 0);
  const request = fake.state.authorizeRequests[0];
  await fetch(`${request.redirectUri}?code=${fake.state.issuedCode}&state=not-the-right-state`);
  const code = await login;
  assert.equal(code, 13, output.stderr());
  assert.match(output.stderr(), /CLI_LOGIN_STATE_MISMATCH/);
  assert.equal(store.secrets().read("cp.test"), undefined);
  assert.equal(fake.state.tokenRequests, 0);
});
