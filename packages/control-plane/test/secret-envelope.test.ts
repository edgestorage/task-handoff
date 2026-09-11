import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-keystore-"));
  return { root, keyPath: path.join(root, "keystore", "database-encryption-key.json") };
}

test("secret envelope binds ciphertext to its context and protects the key file", () => {
  const current = fixture();
  try {
    const service = new SecretEnvelopeService(current.keyPath);
    service.init();
    const envelope = service.seal("model-api-secret", "model:model_one:key");
    assert.equal(service.open(envelope, "model:model_one:key"), "model-api-secret");
    assert.throws(() => service.open(envelope, "model:model_two:key"), (error: any) => {
      assert.equal(error.code, "CONTROL_PLANE_SECRET_AUTHENTICATION_FAILED");
      assert.doesNotMatch(error.message, /model-api-secret/);
      return true;
    });
    assert.equal(fs.statSync(path.dirname(current.keyPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(current.keyPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("environment key remains external and conflicts with a different stored key", () => {
  const current = fixture();
  const firstKey = Buffer.alloc(32, 1).toString("base64url");
  const secondKey = Buffer.alloc(32, 2).toString("base64url");
  try {
    const external = new SecretEnvelopeService(current.keyPath, { key: firstKey });
    external.init();
    assert.equal(fs.existsSync(current.keyPath), false);
    const envelope = external.seal("node-secret", "node:node_one:auth");
    assert.equal(external.open(envelope, "node:node_one:auth"), "node-secret");

    const fileBacked = new SecretEnvelopeService(current.keyPath);
    fileBacked.init();
    const conflict = new SecretEnvelopeService(current.keyPath, { key: secondKey });
    assert.throws(() => conflict.init(), (error: any) => error.code === "CONTROL_PLANE_KEYSTORE_CONFLICT");
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("secret envelope rejects unavailable keys and malformed values without exposing plaintext", () => {
  const first = fixture();
  const second = fixture();
  try {
    const writer = new SecretEnvelopeService(first.keyPath);
    const reader = new SecretEnvelopeService(second.keyPath);
    writer.init();
    reader.init();
    const envelope = writer.seal("private-key-material", "git:credential_one:secret");
    assert.throws(() => reader.open(envelope, "git:credential_one:secret"), (error: any) => {
      assert.equal(error.code, "CONTROL_PLANE_KEYSTORE_MISMATCH");
      assert.doesNotMatch(error.message, /private-key-material/);
      return true;
    });
    assert.throws(() => reader.open("not-an-envelope", "git:credential_one:secret"), (error: any) => (
      error.code === "CONTROL_PLANE_SECRET_ENVELOPE_INVALID"
    ));
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});
