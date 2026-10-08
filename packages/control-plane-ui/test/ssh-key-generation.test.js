import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helperUrl = new URL("../src/apps/control-plane/settings/sshKeyGeneration.ts", import.meta.url);

function hasSshKeygen() {
  return !spawnSync("ssh-keygen", ["-h"]).error;
}

test("ssh key generator emits an OpenSSH ed25519 pair that ssh-keygen accepts", async (t) => {
  let generateEd25519SshKey;
  try {
    ({ generateEd25519SshKey } = await import(helperUrl.href));
  } catch (error) {
    t.skip(`TypeScript module could not be loaded: ${error.message}`);
    return;
  }

  const key = await generateEd25519SshKey("taskhandoff-test");
  assert.equal(key.algorithm, "ssh-ed25519");
  assert.match(key.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* taskhandoff-test$/);
  assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);

  if (!hasSshKeygen()) {
    t.diagnostic("ssh-keygen is unavailable; skipping interoperability check");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-key-generation-"));
  const keyPath = path.join(dir, "id_ed25519");
  try {
    fs.writeFileSync(keyPath, key.privateKey, { mode: 0o600 });
    const derived = execFileSync("ssh-keygen", ["-y", "-f", keyPath], { encoding: "utf8" }).trim();
    assert.equal(derived, key.publicKey);
    const listed = execFileSync("ssh-keygen", ["-lf", keyPath], { encoding: "utf8" }).trim();
    assert.ok(listed.includes(key.fingerprint));
    assert.ok(listed.includes("ED25519"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
