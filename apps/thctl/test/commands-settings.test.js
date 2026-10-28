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
  let cloudAccountSignedIn = false;
  let cloudScopes = { deviceAccess: false, nodeRelay: true };
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
    if (method === "GET" && parsed.pathname === "/api/cloud-account") {
      return json(200, { data: cloudAccountSignedIn
        ? { signedIn: true, accountId: "acct_fake000001", email: "admin@example.com", sessionExpiresAt: now }
        : { signedIn: false } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-account/sign-in-requests") {
      cloudAccountSignedIn = true;
      return json(200, { data: {
        requestId: "car_fake0000001",
        scope: "account:sign-in",
        expiresAt: now,
        authorizationUrl: "https://cloud.example.com/account/authorize",
      } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-connectivity/binding-requests") {
      return json(200, { data: {
        requestId: "cbr_fake0000001",
        scope: "control-plane:bind",
        expiresAt: now,
        authorizationUrl: "https://cloud.example.com/control-planes/authorize?request=cbr_fake0000001",
      } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-account/sign-out") {
      cloudAccountSignedIn = false;
      return json(200, { data: { signedIn: false } });
    }
    if (method === "GET" && parsed.pathname === "/api/cloud-connectivity") {
      return json(200, { data: { version: 2, serviceOrigin: "https://cloud.example.com", status: "unbound", scopes: cloudScopes, remoteAccessEnabled: cloudScopes.deviceAccess, updatedAt: now, identity: { controlPlaneId: "cp_fake", algorithm: "Ed25519", publicKey: "pk", fingerprint: "sha256:x" }, hasBackgroundCredential: false } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-connectivity/remote-access") {
      cloudScopes = body?.scopes ?? { deviceAccess: body?.enabled === true, nodeRelay: false };
      return json(200, { data: { version: 2, serviceOrigin: "https://cloud.example.com", status: "unbound", scopes: cloudScopes, remoteAccessEnabled: cloudScopes.deviceAccess, updatedAt: now, identity: { controlPlaneId: "cp_fake", algorithm: "Ed25519", publicKey: "pk", fingerprint: "sha256:x" }, hasBackgroundCredential: false } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-connectivity/challenges") {
      return json(200, { data: { challengeCode: "binding_challenge_fake.SECRET-CHALLENGE-CODE", authorizationUrl: "https://cloud.example.com/bindings/authorize", payload: { controlPlaneId: "cp_fake", publicKeyFingerprint: "sha256:x", expiresAt: now }, signature: "sig" } });
    }
    if (method === "GET" && parsed.pathname === "/api/cloud-connectivity/account-nodes") {
      return json(200, { data: {
        signedIn: cloudAccountSignedIn,
        nodeRelay: { channels: [], claims: [], errors: [], onboarding: [], trust: [] },
        items: cloudAccountSignedIn ? [{
          nodeHandle: "node_cloud_fake1",
          displayName: "Cloud Build",
          publicKeyFingerprint: "sha256:node",
          status: "active",
          revision: 3,
          createdAt: now,
          updatedAt: now,
          access: { kind: "owner" },
        }] : [],
      } });
    }
    if (method === "POST" && parsed.pathname === "/api/cloud-connectivity/account-nodes/node_cloud_fake1/claim") {
      return json(200, { data: { claimed: true, nodeHandle: "node_cloud_fake1", controlPlaneId: "cp_fake", status: "claimed", revision: 4 } });
    }
    if (method === "DELETE" && parsed.pathname === "/api/cloud-connectivity/account-nodes/node_cloud_fake1/claim") {
      return json(200, { data: { nodeHandle: "node_cloud_fake1", status: "released", revision: 5 } });
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

test("cloud scope commands protect node relay and preserve the legacy route", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);

  const blocked = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "remote-access", "--enabled", "true", "--yes"], {
    store, streams: blocked.streams, fetchImpl: admin.fetchImpl, isTty: false,
  }), 8, blocked.stderr());
  assert.match(blocked.stderr(), /CLI_CLOUD_SCOPE_CONFLICT/);
  assert.match(blocked.stderr(), /cloud scopes set/);
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.path === "/api/cloud-connectivity/remote-access"), false);

  const preview = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "scopes", "set", "--device-access", "false", "--node-relay", "false", "--dry-run"], {
    store, streams: preview.streams, fetchImpl: admin.fetchImpl, isTty: false,
  }), 0, preview.stderr());
  assert.deepEqual(JSON.parse(preview.stdout()).body, { scopes: { deviceAccess: false, nodeRelay: false } });
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.path === "/api/cloud-connectivity/remote-access"), false);

  const scoped = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "scopes", "set", "--device-access", "false", "--node-relay", "false", "--yes"], {
    store, streams: scoped.streams, fetchImpl: admin.fetchImpl, isTty: false,
  }), 0, scoped.stderr());
  assert.deepEqual(JSON.parse(scoped.stdout()).scopes, { deviceAccess: false, nodeRelay: false });
  assert.deepEqual(admin.calls.filter((call) => call.method === "POST" && call.path === "/api/cloud-connectivity/remote-access").at(-1)?.body, {
    scopes: { deviceAccess: false, nodeRelay: false },
  });

  const legacy = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "remote-access", "--enabled", "true", "--yes"], {
    store, streams: legacy.streams, fetchImpl: admin.fetchImpl, isTty: false,
  }), 0, legacy.stderr());
  assert.deepEqual(JSON.parse(legacy.stdout()).scopes, { deviceAccess: true, nodeRelay: false });
  assert.deepEqual(admin.calls.filter((call) => call.method === "POST" && call.path === "/api/cloud-connectivity/remote-access").at(-1)?.body, { enabled: true });
});

test("cloud account and account-node commands use the current API surface", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);

  const refused = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "sign-in"], { store, streams: refused.streams, fetchImpl: admin.fetchImpl, isTty: false }), 4, refused.stderr());
  assert.equal(admin.calls.some((call) => call.path === "/api/cloud-account/sign-in-requests"), false);

  const opened = [];
  const signIn = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "sign-in", "--yes", "--json"], {
    store,
    streams: signIn.streams,
    fetchImpl: admin.fetchImpl,
    isTty: true,
    openUrl: async (url) => opened.push(url),
  }), 0, signIn.stderr());
  assert.equal(JSON.parse(signIn.stdout()).scope, "account:sign-in");
  assert.deepEqual(opened, []);
  assert.ok(admin.calls.some((call) => call.method === "POST" && call.path === "/api/cloud-account/sign-in-requests"));

  const interactiveSignIn = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "sign-in", "--yes", "--table"], {
    store,
    streams: interactiveSignIn.streams,
    fetchImpl: admin.fetchImpl,
    isTty: true,
    openUrl: async (url) => opened.push(url),
  }), 0, interactiveSignIn.stderr());
  assert.deepEqual(opened, ["https://cloud.example.com/account/authorize"]);
  assert.match(interactiveSignIn.stdout(), /account\/authorize/);

  const show = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "show", "--json"], { store, streams: show.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, show.stderr());
  assert.equal(JSON.parse(show.stdout()).email, "admin@example.com");

  const nodes = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account-nodes", "list", "--json"], { store, streams: nodes.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, nodes.stderr());
  const directory = JSON.parse(nodes.stdout());
  assert.equal(directory.items[0].nodeHandle, "node_cloud_fake1");
  assert.deepEqual(directory.nodeRelay.channels, []);

  const claimRefused = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account-nodes", "claim", "node_cloud_fake1"], { store, streams: claimRefused.streams, fetchImpl: admin.fetchImpl, isTty: false }), 4, claimRefused.stderr());
  assert.equal(admin.calls.some((call) => call.method === "POST" && call.path.endsWith("/node_cloud_fake1/claim")), false);

  const claim = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account-nodes", "claim", "node_cloud_fake1", "--yes", "--json"], { store, streams: claim.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, claim.stderr());
  assert.equal(JSON.parse(claim.stdout()).claimed, true);

  const release = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account-nodes", "release", "node_cloud_fake1", "--yes", "--json"], { store, streams: release.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, release.stderr());
  assert.equal(JSON.parse(release.stdout()).status, "released");

  const signOut = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "sign-out", "--yes", "--json"], { store, streams: signOut.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, signOut.stderr());
  assert.equal(JSON.parse(signOut.stdout()).signedIn, false);
});

test("cloud bind starts browser approval without exposing the challenge secret", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);

  const refused = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "bind"], { store, streams: refused.streams, fetchImpl: admin.fetchImpl, isTty: false }), 4, refused.stderr());
  assert.equal(admin.calls.some((call) => call.path === "/api/cloud-connectivity/binding-requests"), false);

  const preview = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "bind", "--dry-run"], { store, streams: preview.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, preview.stderr());
  assert.equal(JSON.parse(preview.stdout()).path, "/api/cloud-connectivity/binding-requests");

  const signedOut = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "bind", "--yes"], { store, streams: signedOut.streams, fetchImpl: admin.fetchImpl, isTty: false }), 5, signedOut.stderr());
  assert.match(signedOut.stderr(), /CLOUD_ACCOUNT_SIGN_IN_REQUIRED/);
  assert.equal(admin.calls.some((call) => call.path === "/api/cloud-connectivity/binding-requests"), false);

  const signIn = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "account", "sign-in", "--yes", "--json"], { store, streams: signIn.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, signIn.stderr());

  const opened = [];
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "cloud", "bind", "--yes", "--table"], {
    store,
    streams: output.streams,
    fetchImpl: admin.fetchImpl,
    isTty: true,
    openUrl: async (url) => opened.push(url),
  }), 0, output.stderr());
  assert.deepEqual(opened, ["https://cloud.example.com/control-planes/authorize?request=cbr_fake0000001"]);
  assert.match(output.stdout(), /control-plane:bind/);
  assert.doesNotMatch(output.stdout(), /challengeCode|SECRET-CHALLENGE-CODE/);
  assert.ok(admin.calls.some((call) => call.method === "POST" && call.path === "/api/cloud-connectivity/binding-requests"));
});

test("diagnostic logs export writes to --out and keeps the archive off stdout", async () => {
  const { store, fake } = await signedIn();
  const admin = settingsFetch(fake);
  const target = path.join(store.directory, "diagnostics.tar.gz");
  const output = capture();
  assert.equal(await runCli(["node", "thctl", "control-plane", "diagnostic-logs", "export", "--out", target, "--table"], { store, streams: output.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, output.stderr());
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
  assert.equal(await runCli(["node", "thctl", "user", "list", "--table"], { store, streams: users.streams, fetchImpl: admin.fetchImpl, isTty: false }), 0, users.stderr());
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
