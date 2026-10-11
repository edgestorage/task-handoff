import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseSshKeyscanOutput, probeGitSshHostKeys } from "../src/control-plane/git-credentials/ssh-host-key-probe.ts";
import type { CommandRunner } from "../src/shared/process/command-runner.ts";

function sshBlob(keyType: string, payload = Buffer.alloc(32, 7)) {
  const type = Buffer.from(keyType, "utf8");
  const typeLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(type.length);
  const payloadLength = Buffer.alloc(4);
  payloadLength.writeUInt32BE(payload.length);
  return Buffer.concat([typeLength, type, payloadLength, payload]).toString("base64");
}

function fingerprint(encoded: string) {
  return `SHA256:${crypto.createHash("sha256").update(Buffer.from(encoded, "base64")).digest("base64").replace(/=+$/, "")}`;
}

test("keyscan output becomes same-port and bracketed non-default-port known_hosts entries", () => {
  const ed25519 = sshBlob("ssh-ed25519");
  const rsa = sshBlob("ssh-rsa");
  const stdout = [
    "# git.example.com:22 SSH-2.0-OpenSSH_9.6",
    `git.example.com ssh-rsa ${rsa}`,
    `git.example.com ssh-ed25519 ${ed25519}`,
    "this line has no key material",
    `git.example.com ssh-ed25519 ${ed25519}`,
    "",
  ].join("\n");

  const entries = parseSshKeyscanOutput("git.example.com", 22, stdout);
  assert.deepEqual(entries.map((entry) => entry.keyType), ["ssh-ed25519", "ssh-rsa"]);
  assert.equal(entries[0].knownHosts, `git.example.com ssh-ed25519 ${ed25519}`);
  assert.equal(entries[0].fingerprint, fingerprint(ed25519));

  const customPort = parseSshKeyscanOutput("git.example.com", 2222, stdout);
  assert.equal(customPort[0].knownHosts, `[git.example.com]:2222 ssh-ed25519 ${ed25519}`);
});

test("a blob whose algorithm disagrees with its label is discarded", () => {
  const mismatched = sshBlob("ssh-rsa");
  const entries = parseSshKeyscanOutput("git.example.com", 22, `git.example.com ssh-ed25519 ${mismatched}`);
  assert.deepEqual(entries, []);
});

test("the probe normalizes the host and option-terminates the keyscan arguments", async () => {
  const ed25519 = sshBlob("ssh-ed25519");
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: `GIT.EXAMPLE.com ssh-ed25519 ${ed25519}`, stderr: "" };
  };

  const result = await probeGitSshHostKeys({ host: "GIT.EXAMPLE.com" }, runner);
  assert.equal(result.host, "git.example.com");
  assert.equal(result.port, 22);
  assert.equal(result.knownHosts, `git.example.com ssh-ed25519 ${ed25519}`);
  assert.deepEqual(calls[0].args, ["-T", "10", "-p", "22", "-t", "rsa,ecdsa,ed25519", "--", "git.example.com"]);

  await probeGitSshHostKeys({ host: "git.example.com", port: 2222 }, runner);
  assert.deepEqual(calls[1].args, ["-T", "10", "-p", "2222", "-t", "rsa,ecdsa,ed25519", "--", "git.example.com"]);
});

test("probe failures map to stable error codes", async () => {
  const missingBinary: CommandRunner = async () => {
    throw Object.assign(new Error("spawn ssh-keyscan ENOENT"), { code: "ENOENT" });
  };
  await assert.rejects(
    probeGitSshHostKeys({ host: "git.example.com" }, missingBinary),
    (error: { code?: string; statusCode?: number }) => error.code === "GIT_SSH_HOST_KEY_PROBE_UNAVAILABLE" && error.statusCode === 501,
  );

  const unreachable: CommandRunner = async () => {
    throw Object.assign(new Error("ssh-keyscan failed."), { code: "RUNTIME_COMMAND_FAILED" });
  };
  await assert.rejects(
    probeGitSshHostKeys({ host: "git.example.com" }, unreachable),
    (error: { code?: string; statusCode?: number }) => error.code === "GIT_SSH_HOST_KEY_PROBE_FAILED" && error.statusCode === 502,
  );

  const empty: CommandRunner = async () => ({ stdout: "# git.example.com:22 SSH-2.0-OpenSSH_9.6\n", stderr: "" });
  await assert.rejects(
    probeGitSshHostKeys({ host: "git.example.com" }, empty),
    (error: { code?: string }) => error.code === "GIT_SSH_HOST_KEY_PROBE_EMPTY",
  );
});
