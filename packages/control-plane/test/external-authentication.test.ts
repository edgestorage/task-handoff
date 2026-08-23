import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneExternalAuthentication } from "../src/control-plane/auth/external-authentication.ts";
import { ControlPlaneIdentityProviderService } from "../src/control-plane/auth/identity-provider-service.ts";
import { ControlPlaneUserAuthentication } from "../src/control-plane/auth/user-authentication.ts";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

test("GitHub OAuth resolves only provider subject and consumes state once", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-external-auth-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    const admin = await users.bootstrapAdmin({ username: "admin", password: "password123" });
    const providers = new ControlPlaneIdentityProviderService(paths, users.store);
    providers.init();
    const provider = await providers.create({
      name: "GitHub",
      kind: "github",
      status: "enabled",
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://cp.example.com/api/auth/external/callback",
    });
    await users.bindExternalIdentity(admin.id, { providerId: provider.id, subject: "1234", kind: "oauth", verifiedEmail: "old@example.com" });
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "temporary-provider-token" }), { status: 200 });
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 1234, login: "alice", email: "same-as-another-user@example.com" }), { status: 200 });
      return new Response(JSON.stringify([{ email: "verified@example.com", primary: true, verified: true }]), { status: 200 });
    };
    const external = new ControlPlaneExternalAuthentication(users, new ControlPlaneUserAuthentication(users), providers, { fetch: fetchMock });
    const begin = await external.begin(provider.id);
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    const result = await external.callback({ state, code: "authorization-code" });
    assert.equal(result.kind, "session");
    assert.equal(result.user.id, admin.id);
    await assert.rejects(() => external.callback({ state, code: "authorization-code" }), { code: "AUTH_EXTERNAL_FLOW_INVALID" });
    assert.deepEqual(calls, ["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/emails"]);
    assert.equal(JSON.stringify(users.store.identities.list()).includes("temporary-provider-token"), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unbound identities never auto-link by email", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-external-auth-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    await users.bootstrapAdmin({ username: "admin@example.com", password: "password123" });
    const providers = new ControlPlaneIdentityProviderService(paths, users.store);
    providers.init();
    const provider = await providers.create({ name: "GitHub", kind: "github", status: "enabled", clientId: "id", clientSecret: "secret", callbackUrl: "https://cp.example.com/callback" });
    const external = new ControlPlaneExternalAuthentication(users, new ControlPlaneUserAuthentication(users), providers, { fetch: async (input) => {
      const url = String(input);
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 9999, login: "admin", email: "admin@example.com" }), { status: 200 });
      return new Response(JSON.stringify([{ email: "admin@example.com", primary: true, verified: true }]), { status: 200 });
    } });
    const begin = await external.begin(provider.id);
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    await assert.rejects(() => external.callback({ state, code: "code" }), { code: "AUTH_EXTERNAL_IDENTITY_NOT_BOUND" });
    assert.equal(users.store.users.list().length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin-approved-create produces a pending request and explicit user", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-external-auth-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    const admin = await users.bootstrapAdmin({ username: "admin", password: "password123" });
    const providers = new ControlPlaneIdentityProviderService(paths, users.store);
    providers.init();
    const provider = await providers.create({ name: "GitHub", kind: "github", status: "enabled", loginPolicy: "admin-approved-create", clientId: "id", clientSecret: "secret", callbackUrl: "https://cp.example.com/callback" });
    const external = new ControlPlaneExternalAuthentication(users, new ControlPlaneUserAuthentication(users), providers, { fetch: async (input) => {
      const url = String(input);
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 7777, login: "new-user" }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    } });
    const begin = await external.begin(provider.id);
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    const pending = await external.callback({ state, code: "code" });
    assert.equal(pending.kind, "pending-approval");
    const created = await users.approveExternalIdentity(admin.id, pending.approvalId, {
      displayName: "New User",
      roleIds: ["role_viewer"],
      nodeScope: { kind: "selected", nodeIds: ["node_1"] },
    });
    assert.equal(created.identities[0].subject, "7777");
    assert.equal(created.primaryUsername, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("external login state is process-local and provider disablement aborts callback", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-external-auth-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    await users.bootstrapAdmin({ username: "admin", password: "password123" });
    const providers = new ControlPlaneIdentityProviderService(paths, users.store);
    providers.init();
    const provider = await providers.create({ name: "GitHub", kind: "github", status: "enabled", clientId: "id", clientSecret: "secret", callbackUrl: "https://cp.example.com/callback" });
    const auth = new ControlPlaneUserAuthentication(users);
    const firstProcess = new ControlPlaneExternalAuthentication(users, auth, providers, { fetch: async () => new Response("{}", { status: 500 }) });
    const begin = await firstProcess.begin(provider.id);
    const url = new URL(begin.authorizationUrl);
    const state = url.searchParams.get("state")!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const restartedProcess = new ControlPlaneExternalAuthentication(users, auth, providers, { fetch: async () => new Response("{}", { status: 500 }) });
    await assert.rejects(() => restartedProcess.callback({ state, code: "code" }), { code: "AUTH_EXTERNAL_FLOW_INVALID" });
    await providers.update(provider.id, { status: "disabled" });
    await assert.rejects(() => firstProcess.callback({ state, code: "code" }), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE" });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
