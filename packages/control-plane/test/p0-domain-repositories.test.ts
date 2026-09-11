import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { ControlPlaneNodeRepository, ControlPlaneNodeStore, ControlPlanePairingRevokeRepository, ControlPlanePairingRevokeStore } from "../src/control-plane/nodes/repository.ts";

test("Model and Node repositories encrypt secrets and do not persist node observations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-domain-repo-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const models = new ControlPlaneModelRepository(database, secrets);
  const nodes = new ControlPlaneNodeRepository(database, secrets);
  const revocations = new ControlPlanePairingRevokeRepository(database, secrets);
  const timestamp = new Date().toISOString();
  try {
    await models.put({ id: "model_one", name: "One", endpoint: "https://models.example.com", key: "plain-model-key", model: "gpt-test", modelNames: [{ name: "gpt-test", order: 100 }], protocols: ["openai-responses"], app: "codex", enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp });
    assert.equal((await models.get("model_one"))?.key, "plain-model-key");
    const modelRecord = await database.models.get("model_one");
    assert.ok(modelRecord?.keyCiphertext.startsWith("v1.key_"));
    assert.doesNotMatch(modelRecord!.keyCiphertext, /plain-model-key/);

    await nodes.put({ id: "node_one", name: "One", connectionMode: "direct-http", connectionPath: { kind: "direct" }, connectionEnabled: true, auth: { mode: "paired-hmac", keyId: "key_one", secret: "plain-node-secret", pairedAt: timestamp, pairing: { status: "paired" } }, endpoint: "https://node.example.com", status: "online", health: "ok", capabilities: { agent: { arbitrary: true } }, appInventory: { observedAt: timestamp, items: [] }, labels: {}, lastSeenAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    const restored = await nodes.get("node_one");
    assert.equal(restored?.auth.secret, "plain-node-secret");
    assert.equal(restored?.status, "unknown");
    assert.equal(restored?.health, "unknown");
    assert.deepEqual(restored?.capabilities, {});
    assert.equal(restored?.lastSeenAt, undefined);
    const nodeRecord = await database.nodes.get("node_one");
    assert.ok(nodeRecord?.authSecretCiphertext?.startsWith("v1.key_"));
    assert.equal("status" in nodeRecord!, false);

    await revocations.put({ id: "revoke_one", endpoint: "https://node.example.com", nodeId: "node_one", keyId: "key_one", secret: "plain-revoke-secret", pairedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    assert.equal((await revocations.get("revoke_one"))?.secret, "plain-revoke-secret");
    assert.doesNotMatch((await database.pairingRevocations.get("revoke_one"))!.secretCiphertext, /plain-revoke-secret/);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Node pairing commits configuration and clears its outbox atomically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-node-pairing-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const nodes = new ControlPlaneNodeRepository(database, secrets);
  const revocations = new ControlPlanePairingRevokeRepository(database, secrets);
  const revokeStore = new ControlPlanePairingRevokeStore(revocations);
  const timestamp = "2026-08-01T00:00:00.000Z";
  const node = { id: "node_pairing", name: "Pairing", connectionMode: "reverse-wss" as const, connectionPath: { kind: "direct" as const }, connectionEnabled: true, auth: { mode: "paired-hmac" as const, keyId: "key_pairing", secret: "node-secret", pairedAt: timestamp, pairing: { status: "paired" as const } }, status: "unknown" as const, health: "unknown" as const, capabilities: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp };
  const pending = { id: "revoke_pairing", endpoint: "https://node.example.com", nodeId: node.id, keyId: "key_pairing", secret: "node-secret", pairedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
  try {
    await revokeStore.init();
    await revokeStore.put(pending);
    const store = new ControlPlaneNodeStore(nodes, {
      commitPairing: (candidate, revokeId) => database.transaction(async (transaction) => {
        const stored = await new ControlPlaneNodeRepository(transaction, secrets).put(candidate);
        await transaction.pairingRevocations.delete(revokeId);
        return stored;
      }),
    });
    await store.init();
    await store.commitPairing(node, pending.id);
    await revokeStore.delete(pending.id);
    assert.equal((await nodes.get(node.id))?.id, node.id);
    assert.equal(await revocations.get(pending.id), undefined);

    const failedPending = { ...pending, id: "revoke_failed" };
    await revokeStore.put(failedPending);
    await assert.rejects(() => database.transaction(async (transaction) => {
      await new ControlPlaneNodeRepository(transaction, secrets).put({ ...node, id: "node_failed" });
      await transaction.pairingRevocations.delete(failedPending.id);
      throw new Error("injected node commit failure");
    }), /injected node commit failure/);
    assert.equal(await nodes.get("node_failed"), undefined);
    assert.equal((await revocations.get(failedPending.id))?.id, failedPending.id);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Node store keeps runtime observations out of configuration mutations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-node-store-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneNodeRepository(database, secrets);
  const store = new ControlPlaneNodeStore(repository);
  const createdAt = "2026-08-01T00:00:00.000Z";
  try {
    await repository.put({ id: "node_one", name: "One", connectionMode: "direct-http", connectionPath: { kind: "direct" }, connectionEnabled: true, auth: { mode: "paired-hmac", keyId: "key_one", secret: "node-secret", pairedAt: createdAt, pairing: { status: "paired" } }, endpoint: "https://node.example.com", status: "online", health: "ok", capabilities: { agent: { stale: true } }, labels: {}, createdAt, updatedAt: createdAt });
    await store.init();
    assert.equal(store.get("node_one")?.status, "unknown");

    const observedAt = "2026-08-01T00:05:00.000Z";
    store.observe({ ...store.get("node_one")!, status: "online", health: "ok", capabilities: { agent: { current: true } }, lastSeenAt: observedAt, updatedAt: observedAt });
    assert.equal(store.get("node_one")?.status, "online");
    assert.deepEqual(store.get("node_one")?.capabilities, { agent: { current: true } });
    assert.equal((await database.nodes.get("node_one"))?.updatedAt, createdAt);

    await store.put({ ...store.get("node_one")!, name: "Renamed", status: "offline", health: "failed", capabilities: {}, updatedAt: observedAt });
    assert.equal(store.get("node_one")?.name, "Renamed");
    assert.equal(store.get("node_one")?.status, "online");
    assert.deepEqual(store.get("node_one")?.capabilities, { agent: { current: true } });
    assert.equal((await database.nodes.get("node_one"))?.name, "Renamed");
    assert.equal("status" in (await database.nodes.get("node_one"))!, false);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
