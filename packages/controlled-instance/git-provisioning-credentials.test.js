import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitProvisioningCredentialsForTest } from "./src/web/git-provisioning-credentials.ts";
import { parseGitSshInvocation, remoteFromHttpsCredentialRequest } from "./src/web/git-transport.ts";

function credential(root, index, scope, files) {
  const directory = path.join(root, `credential-${index}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "scope.json"), JSON.stringify(scope), { mode: 0o600 });
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
  return directory;
}

test("provisioning credential selection uses the protocol normalizer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-selector-"));
  try {
    credential(root, 0, { scheme: "https", host: "git.example.com", pathPrefix: "/" }, { username: "root", token: "root-token" });
    const repository = credential(root, 1, { scheme: "https", host: "git.example.com", pathPrefix: "/team/repo/" }, { username: "repo", token: "repo-token" });
    const ipv6 = credential(root, 2, { scheme: "https", host: "::1", port: 8443, pathPrefix: "/Team/" }, { username: "ipv6", token: "ipv6-token" });
    const idna = credential(root, 3, { scheme: "https", host: "xn--bcher-kva.example", pathPrefix: "/" }, { username: "idna", token: "idna-token" });

    assert.equal(gitProvisioningCredentialsForTest.selectCredential("https://git.example.com:443/team/repo.git", root), repository);
    assert.equal(gitProvisioningCredentialsForTest.selectCredential("https://[::1]:8443/Team/Repo.git", root), ipv6);
    assert.equal(gitProvisioningCredentialsForTest.selectCredential("https://b\u00fccher.example/project.git", root), idna);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provisioning credential selection preserves longest-scope and ambiguity semantics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-selector-"));
  try {
    credential(root, 0, { scheme: "ssh", host: "git.example.com", pathPrefix: "/" }, { "public-identity": "ssh-ed25519 root", known_hosts: "host key" });
    const team = credential(root, 1, { scheme: "ssh", host: "git.example.com", pathPrefix: "/team/" }, { "public-identity": "ssh-ed25519 team", known_hosts: "host key" });
    assert.equal(gitProvisioningCredentialsForTest.selectCredential("git@git.example.com:team/submodule.git", root), team);

    credential(root, 2, { scheme: "ssh", host: "git.example.com", pathPrefix: "/team/" }, { "public-identity": "ssh-ed25519 duplicate", known_hosts: "host key" });
    assert.throws(
      () => gitProvisioningCredentialsForTest.selectCredential("git@git.example.com:team/submodule.git", root),
      /TASK_HANDOFF_GIT_PROVISIONING_ERROR=AMBIGUOUS/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git transport adapters only construct remotes and sanitize SSH arguments", () => {
  assert.equal(
    remoteFromHttpsCredentialRequest({ protocol: "https", host: "[::1]:8443", path: "Team/Repo.git" }),
    "https://[::1]:8443/Team/Repo.git",
  );
  assert.deepEqual(parseGitSshInvocation(["-p", "22", "git@git.example.com", "git-upload-pack 'team/repo.git'"]), {
    remote: "ssh://git.example.com:22/team/repo.git",
    args: ["-p", "22", "git@git.example.com", "git-upload-pack 'team/repo.git'"],
  });
  assert.equal(parseGitSshInvocation(["-o", "ProxyCommand=evil", "git.example.com", "git-upload-pack 'repo.git'"]), undefined);
});
