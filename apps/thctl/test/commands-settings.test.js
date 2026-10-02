import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { createFakeControlPlane } from "./helpers/fake-control-plane.js";

const now = new Date().toISOString();

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempStore() {
  return new CliProfileStore(fs.mkdtempSync(path.join(os.tmpdir(), "thctl-settings-")));
}

const ACCESS_CAPABILITIES = {
  userManagement: { users: true, identities: true, sessions: true },
  authentication: {},
  authorization: { customRoles: true, nodeScopes: true, authorizationRevisions: true },
};

async function signedIn(capabilities) {
  const store = tempStore();
  const fake = createFakeControlPlane({ origin: "http://cp.test", ...(capabilities ? { capabilities } : {}) });
  await runCli(["node", "thctl", "profile", "add", "http://cp.test"], { store, streams: capture().streams, fetchImpl: fake.fetchImpl, isTty: false });
  let polls = 0;
  const output = capture();
  const code = await runCli(["node", "thctl", "login", "--device"], {
    store, streams: output.streams, fetchImpl: fake.fetchImpl, isTty: false,
    sleep: async () => { if (++polls >= 2) fake.state.deviceApproved = true; },
  });
  assert.equal(code, 0, output.stderr());
  return { store, fake };
}

function settingsFetch(fake) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: parsed.pathname, search: parsed.search, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && parsed.pathname === "/api/projects") {
      return json(200, { data: [{ id: "prj_fake0000001", name: "Demo", source: { type: "local-folder", path: "/workspace/demo" }, workspacePolicy: { mode: "local-bind", path: "/workspace" }, labels: {}, createdAt: now, updatedAt: now }] });
    }
    if (method === "GET" && parsed.pathname === "/api/git-credentials") {
      return json(200, { data: { items: [{ id: "gcred_fake0001", name: "Deploy", kind: "https-token", scope: { scheme: "https", host: "example.com" }, secretSet: true, status: "enabled", revision: 1, createdAt: now, updatedAt: now }] } });
    }
    if (method === "POST" && parsed.pathname === "/api/git-credentials") {
      return json(201, { data: { id: "gcred_new0001", name: body?.name ?? "New", kind: "https-token", scope: { scheme: "https", host: "example.com" }, secretSet: true, status: "enabled", revision: 1, createdAt: now, updatedAt: now } });
    }
    if (method === "GET" && parsed.pathname === "/api/chat-gateway/bridges") {
      return json(200, { data: [{ id: "brg_fake0000001", channel: "telegram", name: "Ops", running: true, tokenSet: true }] });
    }
    if (method === "POST" && parsed.pathname === "/api/chat-gateway/bridges") {
      return json(201, { data: { id: "brg_new0000001", channel: "telegram", name: body?.name ?? "Ops", running: false, tokenSet: true } });
    }
    if (method === "GET" && parsed.pathname === "/api/control-plane/settings") {
      return json(200, { data: { updateChannel: "stable", mentionTrigger: "@", commandTrigger: "/", diagnosticLogs: false } });
    }
    if (method === "GET" && parsed.pathname === "/api/control-plane/diagnostic-logs/export") {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="diagnostics.tar.gz"' } });
    }
    if (method === "GET" && parsed.pathname === "/api/cloud-connectivity") {
      return json(200, { data: { version: 1, serviceOrigin: "https://cloud.example.com", status: "unbound", remoteAccessEnabled: false, updatedAt: now, identity: { controlPlaneId: "cp_fake", algorithm: "Ed25519", publicKey: "pk", fingerprint: "sha256:x" }, hasBackgroundCredential: false } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-connectivity/challenges") {
      return json(200, { data: { challengeCode: "binding_challenge_fake.SECRET-CHALLENGE-CODE", authorizationUrl: "https://cloud.example.com/bindings/authorize", payload: { controlPlaneId: "cp_fake", publicKeyFingerprint: "sha256:x", expiresAt: now }, signature: "sig" } });
    }
    if (method === "GET" && parsed.pathname === "/api/auth/mobile/sessions") {
      return json(200, { data: [{
        id: "msess_fake0001",
        userId: "user_fake0000000",
        identityId: "identity_fake000",
        clientType: "mobile",
        createdAt: now,
        expiresAt: now,
        device: { id: "device_fake0001", name: "iPhone", platform: "ios" },
        user: { id: "user_fake0000000", displayName: "Fake Admin", status: "active", createdAt: now, updatedAt: now },
      }] });
    }
    if (method === "GET" && parsed.pathname === "/api/roles") {
      return json(200, { data: [{ id: "role_admin", name: "Admin", description: "Built-in administrator", system: true, builtin: true, status: "active", permissionIds: [], createdAt: now, updatedAt: now }] });
    }
    if (method === "GET" && parsed.pathname === "/api/identity-providers") {
      return json(200, { data: [{ id: "idp_fake0001", name: "Okta", kind: "oidc", status: "enabled", loginPolicy: "existing-only", issuer: "https://okta.example.com", clientId: "client-1", callbackUrl: "https://cp.test/api/auth/oidc/callback", clientSecretConfigured: true, createdAt: now, updatedAt: now }] });
    }
    return fake.fetchImpl(url, init);
  };
  return { fetchImpl, calls };
}

function writeConfig(store, value) {
  const file = path.join(store.directory, "body.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("catalog and credential reads render the shared client projections", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const projects = capture();
  assert.equal(await runCli(["node", "thctl", "project", "list"], { store, streams: projects.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, projects.stderr());
  assert.match(projects.stdout(), /Demo/);

  const credentials = capture();
  assert.equal(await runCli(["node", "thctl", "git-credential", "list", "--json"], { store, streams: credentials.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, credentials.stderr());
  const payload = JSON.parse(credentials.stdout());
  assert.equal(payload.items[0].id, "gcred_fake0001");
  assert.equal("token" in payload.items[0], false);
  assert.equal(payload.items[0].secretSet, true);
});

test("secret-bearing writes gate on confirmation and redact dry-run bodies", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const config = writeConfig(store, { name: "Deploy", scope: { scheme: "https", host: "example.com" }, secret: { kind: "https-token", username: "git", token: "ghp_super_secret_value" } });
  const refused = capture();
  assert.equal(await runCli(["node", "thctl", "git-credential", "create", "--config", config], { store, streams: refused.streams, fetchImpl: admin.fetchImpl, isTty: false }), 4, refused.stderr());
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.path === "/api/git-credentials"), false);

  const preview = capture();
  assert.equal(await runCli(["node", "thctl", "git-credential", "create", "--config", config, "--dry-run"], { store, streams: preview.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, preview.stderr());
  assert.doesNotMatch(preview.stdout(), /ghp_super_secret_value/);
  assert.match(preview.stdout(), /\*\*\*/);

  const bridgeConfig = writeConfig(store, { channel: "telegram", name: "Ops", token: "bot-token-secret-value" });
  const bridgePreview = capture();
  assert.equal(await runCli(["node", "thctl", "chat", "bridges", "create", "--config", bridgeConfig, "--dry-run"], { store, streams: bridgePreview.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, bridgePreview.stderr());
  assert.doesNotMatch(bridgePreview.stdout(), /bot-token-secret-value/);
});

test("cloud challenge never prints the binding secret", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "challenge", "--yes"], { store, streams: output.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, output.stderr());
  assert.doesNotMatch(output.stdout(), /SECRET-CHALLENGE-CODE/);
  assert.match(output.stdout(), /cloud\.example\.com\/bindings\/authorize/);
});

test("diagnostic logs export writes to --out and keeps the archive off stdout", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const target = path.join(store.directory, "diagnostics.tar.gz");
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "control-plane", "diagnostic-logs", "export", "--out", target], { store, streams: output.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, output.stderr());
  assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3, 4]);
  assert.doesNotMatch(output.stdout(), /\u0001/);
  assert.match(output.stdout(), /Diagnostic logs written/);
});

test("access management capability gaps close only the gated sub-domain", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const roles = capture();
  assert.equal(await runCli(["node", "thctl", "user", "role", "list"], { store, streams: roles.streams, fetchImpl: admin.fetchImpl, isTty: false }), 14, roles.stderr());
  assert.match(roles.stderr(), /CLI_CAPABILITY_MISSING/);
  assert.match(roles.stderr(), /customRoles/);

  const providers = capture();
  assert.equal(await runCli(["node", "thctl", "user", "identity-provider", "list"], { store, streams: providers.streams, fetchImpl: admin.fetchImpl, isTty: false }), 14, providers.stderr());
  assert.match(providers.stderr(), /externalIdentityLogin/);

  const users = capture();
  assert.equal(await runCli(["node", "thctl", "user", "list"], { store, streams: users.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, users.stderr());
  assert.match(users.stdout(), /Fake Admin/);
});

test("access management commands work when the Control Plane declares the capabilities", async () => {
  const { store, fake } = await signedIn({
    authentication: "required",
    aiSessions: true,
    nodes: true,
    instanceBoard: true,
    triggers: true,
    stories: true,
    cliSessions: true,
    accessManagement: {
      userManagement: ACCESS_CAPABILITIES.userManagement,
      authentication: { externalIdentity: { oidc: true, oauthAdapters: [] } },
      authorization: ACCESS_CAPABILITIES.authorization,
    },
  });
  const admin = settingsFetch(fake);
  const roles = capture();
  assert.equal(await runCli(["node", "thctl", "user", "role", "list", "--json"], { store, streams: roles.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, roles.stderr());
  assert.equal(JSON.parse(roles.stdout())[0].id, "role_admin");

  const providers = capture();
  assert.equal(await runCli(["node", "thctl", "user", "identity-provider", "list"], { store, streams: providers.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, providers.stderr());
  assert.match(providers.stdout(), /Okta/);

  const mobile = capture();
  assert.equal(await runCli(["node", "thctl", "mobile-session", "list"], { store, streams: mobile.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, mobile.stderr());
  assert.match(mobile.stdout(), /msess_fake0001/);
});
