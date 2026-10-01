import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI_CONFIG_DIR_ENV, CLI_PROFILE_ENV, CliProfileStore, resolveCliConfigDir } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

function tempStore() {
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-profile-")));
}

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function modes(target) {
  return fs.statSync(target).mode & 0o777;
}

test("config directory honours the environment override and XDG layout", () => {
  assert.equal(resolveCliConfigDir({ [CLI_CONFIG_DIR_ENV]: "/tmp/thctl-custom" }), "/tmp/thctl-custom");
  assert.equal(resolveCliConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/xdg/task-handoff/cli");
  assert.match(resolveCliConfigDir({}), /\.config\/task-handoff\/cli$/);
});

test("profile store keeps metadata private and separates credentials", () => {
  const store = tempStore();
  const now = new Date().toISOString();
  store.save({
    label: "local",
    origin: "http://127.0.0.1:8787",
    controlPlaneId: "cp_local",
    fingerprint: `sha256:${"A".repeat(43)}`,
    protocolVersion: "2026-10-01",
    createdAt: now,
    updatedAt: now,
    trustedAt: now,
  });
  store.setDefault("local");
  store.secrets().write("local", { sessionToken: "csess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.token", savedAt: now });

  assert.equal(modes(store.directory), 0o700);
  assert.equal(modes(store.file), 0o600);
  assert.equal(modes(store.credentialFile), 0o600);
  assert.doesNotMatch(fs.readFileSync(store.file, "utf8"), /csess_|sessionToken/);
  assert.match(fs.readFileSync(store.credentialFile, "utf8"), /csess_/);
  assert.equal(store.select().label, "local");
  assert.equal(store.select("local").label, "local");
  assert.equal(store.select(undefined, { [CLI_PROFILE_ENV]: "local" }).label, "local");
  assert.throws(() => store.select(undefined, { [CLI_PROFILE_ENV]: "missing" }), /CLI_PROFILE_UNKNOWN|Unknown profile/);
  store.remove("local");
  assert.equal(store.get("local"), undefined);
  assert.equal(store.secrets().read("local"), undefined);
  assert.equal(fs.existsSync(store.credentialFile), true);
});

test("profile selection prefers the flag over the environment and reports missing selection", () => {
  const store = tempStore();
  const now = new Date().toISOString();
  for (const label of ["alpha", "beta"]) {
    store.save({
      label,
      origin: `http://${label}.test`,
      controlPlaneId: `cp_${label}`,
      fingerprint: `sha256:${label === "alpha" ? "A".repeat(43) : "B".repeat(43)}`,
      protocolVersion: "2026-10-01",
      createdAt: now,
      updatedAt: now,
      trustedAt: now,
    });
  }
  assert.throws(() => store.select(undefined, {}), /CLI_PROFILE_REQUIRED|Multiple profiles/);
  assert.equal(store.select("beta", { [CLI_PROFILE_ENV]: "alpha" }).label, "beta");
  assert.equal(store.select(undefined, { [CLI_PROFILE_ENV]: "alpha" }).label, "alpha");
  store.setDefault("beta");
  assert.equal(store.select(undefined, {}).label, "beta");
});

test("profile add pins the identity and reuses an existing profile for the same origin", async () => {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://cp.test" });
  const first = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", "http://cp.test", "--label", "dev"], {
    store, streams: first.streams, fetchImpl: fake.fetchImpl, isTty: false,
  }), 0);
  assert.match(first.stdout(), /Added profile `dev`/);
  assert.equal(store.get("dev").fingerprint, fake.identityPayload.publicKey.fingerprint);
  assert.equal(store.defaultProfile(), "dev");
  assert.doesNotMatch(fs.readFileSync(store.file, "utf8"), /sessionToken/);

  const second = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "add", "http://cp.test", "--json"], {
    store, streams: second.streams, fetchImpl: fake.fetchImpl, isTty: false,
  }), 0);
  assert.equal(store.list().length, 1);
  assert.equal(JSON.parse(second.stdout()).label, "dev");
});

test("identity changes are rejected until the profile explicitly re-trusts the fingerprint", async () => {
  const store = tempStore();
  const origin = "http://cp.test";
  const original = createFakeControlPlane({ origin });
  await runCli(["node", "thctl", "profile", "add", origin], { store, streams: capture().streams, fetchImpl: original.fetchImpl, isTty: false });

  const rotated = createFakeControlPlane({ origin, controlPlaneId: "cp_fakecp0000000" });
  const rejected = capture();
  const code = await runCli(["node", "thctl", "instance", "list"], { store, streams: rejected.streams, fetchImpl: rotated.fetchImpl, isTty: false });
  assert.equal(code, 13);
  assert.match(rejected.stderr(), /CLI_IDENTITY_CHANGED/);

  const refused = capture();
  const refuseCode = await runCli(["node", "thctl", "profile", "trust", "cp.test"], { store, streams: refused.streams, fetchImpl: rotated.fetchImpl, isTty: false });
  assert.equal(refuseCode, 4);
  assert.match(refused.stderr(), /CLI_CONFIRMATION_REQUIRED/);

  const trusted = capture();
  const trustCode = await runCli(["node", "thctl", "profile", "trust", "cp.test", "--yes"], { store, streams: trusted.streams, fetchImpl: rotated.fetchImpl, isTty: false });
  assert.equal(trustCode, 0, trusted.stderr());
  const profile = store.get("cp.test");
  assert.equal(profile.fingerprint, rotated.identityPayload.publicKey.fingerprint);
  assert.equal(profile.replacedFingerprint, original.identityPayload.publicKey.fingerprint);
  assert.ok(profile.identityChangedAt);
});

test("control planes without the cliSessions capability are rejected before login", async () => {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://old.test", cliSessions: false });
  await runCli(["node", "thctl", "profile", "add", "http://old.test"], { store, streams: capture().streams, fetchImpl: fake.fetchImpl, isTty: false });
  const output = capture();
  const code = await runCli(["node", "thctl", "login"], { store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false });
  assert.equal(code, 14);
  assert.match(output.stderr(), /CLI_CAPABILITY_MISSING/);
  assert.equal(fake.state.calls.some((call) => call.path === "/api/auth/cli/authorize"), false);
});
