import assert from "node:assert/strict";
import test from "node:test";
import {
  GitCredentialCreateRequestSchema,
  GitCredentialPublicSchema,
  GitCredentialRetentionSchema,
  GitWorkspaceProvisioningInputSchema,
  NodeGitCredentialPayloadSchema,
  normalizeGitCredentialScope,
  normalizeGitRemote,
  resolveGitCredential,
  sanitizeGitCredentialPublic,
  sanitizeGitWorkspaceProvisioningInput,
} from "../src/managed-git-credentials.ts";
import {
  normalizeControlledInstanceCapabilities,
  GitCloneOptionsSchema,
  GitRefSchema,
  normalizeNodeAgentCapabilities,
  supportsGitCliCredentialBroker,
  supportsGitCredentialProxy,
  supportsNodeGitCredentialRuntimeBroker,
  supportsNodeGitWorkspaceProvisioning,
  supportsNodeManagedGitCredentialRegistry,
} from "../src/control-plane.ts";

const timestamp = "2026-08-23T00:00:00.000Z";

test("workspace subdirectory is a relative repository path", () => {
  assert.equal(GitCloneOptionsSchema.parse({ subdirectory: "packages/app" }).subdirectory, "packages/app");
  assert.equal(GitCloneOptionsSchema.parse({ subdirectory: "." }).subdirectory, "");
  assert.equal(GitCloneOptionsSchema.parse({ subdirectory: "./packages//app" }).subdirectory, "packages/app");
  for (const subdirectory of ["/tmp/outside", "../outside", "packages/../outside"]) {
    assert.equal(GitCloneOptionsSchema.safeParse({ subdirectory }).success, false);
  }
  assert.equal(GitWorkspaceProvisioningInputSchema.safeParse({
    operationId: "gitop_one",
    instanceId: "inst_one",
    remoteUrl: "https://git.example.com/team/repo.git",
    ref: { type: "branch", name: "main" },
    clone: { subdirectory: "../outside" },
    credentials: [],
  }).success, false);
});

test("Git refs require the field selected by their discriminator", () => {
  assert.deepEqual(GitRefSchema.parse({ type: "branch", name: "main" }), { type: "branch", name: "main" });
  assert.deepEqual(GitRefSchema.parse({ type: "commit", commit: "deadbeef" }), { type: "commit", commit: "deadbeef" });
  for (const ref of [
    { type: "branch" },
    { type: "tag" },
    { type: "commit" },
    { type: "commit", commit: "--help" },
    { type: "commit", commit: "main" },
    { type: "branch", commit: "deadbeef" },
    { type: "commit", name: "main" },
  ]) {
    assert.equal(GitRefSchema.safeParse(ref).success, false);
    assert.equal(GitWorkspaceProvisioningInputSchema.safeParse({
      operationId: "gitop_one", instanceId: "inst_one", remoteUrl: "https://git.example.com/repo.git",
      ref, clone: {}, credentials: [],
    }).success, false);
  }
});

function credential(
  id: string,
  scope: { scheme: "https" | "ssh"; host: string; port?: number; pathPrefix?: string },
  extras: { kind?: "https-token" | "ssh-key"; pinnedKnownHosts?: boolean } = {},
) {
  return {
    id,
    kind: extras.kind || (scope.scheme === "https" ? "https-token" : "ssh-key"),
    scope: normalizeGitCredentialScope(scope),
    status: "enabled" as const,
    pinnedKnownHosts: extras.pinnedKnownHosts,
  };
}

test("credential input is strict while public projections cannot carry secrets", () => {
  const request = GitCredentialCreateRequestSchema.parse({
    name: "Team token",
    scope: { scheme: "https", host: "Git.Example.COM", port: 443, pathPrefix: "/team" },
    secret: { kind: "https-token", username: "git", token: "token-value" },
  });
  assert.equal(request.secret.token, "token-value");
  assert.throws(() => GitCredentialCreateRequestSchema.parse({ ...request, future: true }));
  assert.throws(() => GitCredentialCreateRequestSchema.parse({
    ...request,
    secret: { kind: "ssh-key", privateKey: "key", pinnedKnownHosts: "host key" },
  }));

  const publicValue = {
    id: "gitcred_one",
    name: "Team token",
    kind: "https-token",
    scope: normalizeGitCredentialScope(request.scope),
    secretSet: true,
    status: "enabled",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  assert.deepEqual(GitCredentialPublicSchema.parse(publicValue), publicValue);
  for (const secretField of ["token", "password", "privateKey", "passphrase"]) {
    assert.throws(() => GitCredentialPublicSchema.parse({ ...publicValue, [secretField]: "must-not-survive" }));
  }
  assert.throws(() => NodeGitCredentialPayloadSchema.parse({ credential: publicValue, secret: { kind: "ssh-key", privateKey: "key", pinnedKnownHosts: "host key" } }));
});

test("instance creation retention cannot carry a credential or secret", () => {
  assert.equal(GitCredentialRetentionSchema.parse("operation-only"), "operation-only");
  assert.equal(GitCredentialRetentionSchema.parse("instance-retained"), "instance-retained");
  assert.throws(() => GitCredentialRetentionSchema.parse("session"));
  assert.throws(() => GitCredentialRetentionSchema.parse({ credentialId: "gitcred_one", retention: "operation-only" }));
});

test("scope normalization covers IDNA, default ports, SSH and safe path segments", () => {
  assert.deepEqual(normalizeGitCredentialScope({ scheme: "https", host: "BÜCHER.example", port: 443, pathPrefix: "Team/Repo.git" }), {
    scheme: "https",
    host: "xn--bcher-kva.example",
    pathPrefix: "/Team/Repo.git/",
  });
  assert.deepEqual(normalizeGitRemote("git@Git.Example.com:Team/Repo.git"), {
    scheme: "ssh",
    host: "git.example.com",
    pathPrefix: "/Team/Repo/",
    original: "git@Git.Example.com:Team/Repo.git",
  });
  assert.equal(normalizeGitRemote("ssh://git@git.example.com:22/Team/Repo.git").port, undefined);
  for (const invalid of [
    { scheme: "https", host: "*.example.com", pathPrefix: "/" },
    { scheme: "https", host: "git.example.com", pathPrefix: "/team/../other" },
    { scheme: "ssh", host: "git.example.com", pathPrefix: "/team/%2e%2e/other" },
  ]) assert.throws(() => normalizeGitCredentialScope(invalid));
  for (const invalid of [
    "http://git.example.com/team/repo.git",
    "https://token@git.example.com/team/repo.git",
    "https://git.example.com/team/repo.git?token=secret",
    "https://git.example.com/team/../other/repo.git",
    "ssh://git@git.example.com/team/%2e%2e/other.git",
    "/local/repository",
  ]) assert.throws(() => normalizeGitRemote(invalid));
});

test("scope and remote normalization support canonical IPv6 hosts", () => {
  assert.deepEqual(normalizeGitCredentialScope({
    scheme: "https",
    host: "[0:0:0:0:0:0:0:1]",
    port: 8443,
    pathPrefix: "/Team/Repo",
  }), {
    scheme: "https",
    host: "::1",
    port: 8443,
    pathPrefix: "/Team/Repo/",
  });
  assert.deepEqual(normalizeGitRemote("https://[::1]:8443/Team/Repo.git"), {
    scheme: "https",
    host: "::1",
    port: 8443,
    pathPrefix: "/Team/Repo/",
    original: "https://[::1]:8443/Team/Repo.git",
  });
  assert.deepEqual(normalizeGitRemote("ssh://git@[2001:db8::1]/Team/Repo.git"), {
    scheme: "ssh",
    host: "2001:db8::1",
    pathPrefix: "/Team/Repo/",
    original: "ssh://git@[2001:db8::1]/Team/Repo.git",
  });
  assert.equal(normalizeGitRemote("ssh://[::1]/Team/Repo.git").host, "::1");

  const ipv6 = credential("gitcred_ipv6", {
    scheme: "https",
    host: "0:0:0:0:0:0:0:1",
    port: 8443,
    pathPrefix: "/Team",
  });
  const result = resolveGitCredential("https://[::1]:8443/Team/Repo.git", [ipv6]);
  assert.equal(result.status, "unique");
});

test("resolver selects one longest segment prefix without trying other credentials", () => {
  const root = credential("gitcred_root", { scheme: "https", host: "git.example.com", pathPrefix: "/" });
  const team = credential("gitcred_team", { scheme: "https", host: "git.example.com", pathPrefix: "/team" });
  const result = resolveGitCredential("https://git.example.com/team/repo.git", [root, team]);
  assert.equal(result.status, "unique");
  if (result.status === "unique") assert.equal(result.credential.id, "gitcred_team");
  assert.equal(resolveGitCredential("https://git.example.com/teamster/repo.git", [team]).status, "none");
  assert.equal(resolveGitCredential("ftp://git.example.com/team/repo.git", [root]).status, "unsupported");
});

test("resolver reports ambiguity and missing SSH host keys before network access", () => {
  const one = credential("gitcred_one", { scheme: "https", host: "git.example.com", pathPrefix: "/team" });
  const two = credential("gitcred_two", { scheme: "https", host: "git.example.com", pathPrefix: "/team" });
  const ambiguous = resolveGitCredential("https://git.example.com/team/repo.git", [two, one]);
  assert.deepEqual(ambiguous.status === "ambiguous" ? ambiguous.credentialIds : [], ["gitcred_one", "gitcred_two"]);
  const ssh = credential("gitcred_ssh", { scheme: "ssh", host: "git.example.com", pathPrefix: "/team" }, { pinnedKnownHosts: false });
  assert.equal(resolveGitCredential("git@git.example.com:team/repo.git", [ssh]).status, "missing-host-key");
});

test("managed Git capabilities normalize N-1 absence and ignore future fields", () => {
  assert.equal(supportsGitCliCredentialBroker({ features: {} }), false);
  assert.equal(supportsGitCredentialProxy({ features: {} }), false);
  assert.equal(supportsGitCliCredentialBroker({ features: { gitCliCredentialBroker: true, future: true }, future: true }), true);
  assert.equal(supportsNodeManagedGitCredentialRegistry({ folderPlaces: true }), false);
  assert.equal(supportsNodeGitWorkspaceProvisioning({}, "docker"), false);
  const node = { managedGitCredentials: { registry: true, runtimeBroker: true, workspaceProvisioning: { docker: true, future: true }, future: true }, future: true };
  assert.equal(supportsNodeManagedGitCredentialRegistry(node), true);
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "docker"), true);
  assert.equal(supportsNodeGitCredentialRuntimeBroker(node), true);
  assert.equal(supportsNodeGitWorkspaceProvisioning(node, "local"), false);
  assert.deepEqual(normalizeNodeAgentCapabilities(node).managedGitCredentials.workspaceProvisioning, {
    docker: true,
    kubernetes: false,
    local: false,
  });
  assert.equal(normalizeControlledInstanceCapabilities({ features: { future: true } }).features.gitCliCredentialBroker, false);
});

test("public response readers ignore future fields without retaining secrets", () => {
  const publicValue = {
    id: "gitcred_one",
    name: "Team token",
    kind: "https-token",
    scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/", futureScope: true },
    secretSet: true,
    status: "enabled",
    revision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    token: "must-not-survive",
    future: true,
  };
  const sanitizedPublic = sanitizeGitCredentialPublic(publicValue);
  assert.equal(sanitizedPublic.success, true);
  if (sanitizedPublic.success) {
    assert.equal("token" in sanitizedPublic.data, false);
    assert.equal("future" in sanitizedPublic.data, false);
    assert.equal("futureScope" in sanitizedPublic.data.scope, false);
  }
});

test("stored workspace provisioning ignores future fields at every private record boundary", () => {
  const parsed = sanitizeGitWorkspaceProvisioningInput({
    operationId: "gitop_one",
    instanceId: "inst_one",
    remoteUrl: "https://git.example.com/team/repo.git",
    ref: { type: "branch", name: "main", future: true },
    clone: { submodules: false, lfs: false, future: true },
    credentials: [{
      operationId: "gitop_one",
      retention: "operation-only",
      future: true,
      payload: {
        future: true,
        credential: {
          id: "gitcred_one", name: "Token", kind: "https-token",
          scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/", future: true },
          secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp, future: true,
        },
        secret: { kind: "https-token", username: "git", token: "secret", future: true },
      },
    }],
    future: true,
  });
  assert.equal(parsed.success, true);
  assert.equal(JSON.stringify(parsed.success ? parsed.data : {}).includes("future"), false);
});
