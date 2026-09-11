import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

type Database = Awaited<ReturnType<typeof createControlPlaneDatabase>>;
type Fixture = { name: string; create(): Promise<{ database: Database; secret: SecretEnvelopeService; cleanup(): Promise<void> }> };

const fixtures: Fixture[] = [{
  name: "sqlite",
  async create() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-p0-db-"));
    const paths = controlPlaneStorePaths(root);
    const database = await createControlPlaneDatabase(paths);
    const secret = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
    secret.init();
    return { database, secret, cleanup: async () => { await database.close(); fs.rmSync(root, { recursive: true, force: true }); } };
  },
}];

const postgresqlUrl = process.env.TASK_HANDOFF_TEST_POSTGRES_URL;
if (postgresqlUrl) fixtures.push({
  name: "postgresql",
  async create() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-p0-pg-"));
    const schema = `task_handoff_p0_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const database = await createControlPlaneDatabase(controlPlaneStorePaths(root), { dialect: "postgresql", connectionString: postgresqlUrl, schema });
    const secret = new SecretEnvelopeService(path.join(root, "key.json"));
    secret.init();
    return { database, secret, cleanup: async () => {
      await database.close();
      const pool = new Pool({ connectionString: postgresqlUrl });
      try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); fs.rmSync(root, { recursive: true, force: true }); }
    } };
  },
});

for (const fixture of fixtures) test(`${fixture.name} P0 repositories enforce relations and transaction rollback`, async () => {
  const current = await fixture.create();
  const timestamp = new Date().toISOString();
  const gitSecret = current.secret.seal(JSON.stringify({ kind: "https-token", username: "git", token: "test-token" }), "git:gitcred_one:secret");
  try {
    await current.database.gitCredentials.put({
      id: "gitcred_one", name: "One", kind: "https-token", scope: { scheme: "https", host: "git.example.com", pathPrefix: "/" },
      status: "enabled", revision: 1, secretCiphertext: gitSecret, createdAt: timestamp, updatedAt: timestamp,
    });
    await current.database.gitAssignments.put({
      id: "instance_one:gitcred_one", instanceId: "instance_one", credentialId: "gitcred_one", credentialRevision: 1,
      assignmentRevision: 1, status: "pending", authorizedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    });
    await assert.rejects(
      () => current.database.gitCredentials.delete("gitcred_one"),
      (error: any) => error.code === "CONTROL_PLANE_DATABASE_FOREIGN_KEY_CONFLICT" && error.statusCode === 409,
    );

    await current.database.chatBridges.put({
      id: "chat_telegram_one", channel: "telegram", name: "Telegram", enabled: false,
      allowedUserIds: [], pollIntervalMs: 3000, settings: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    await current.database.chatSessions.put({
      id: "chat_telegram_one:room", routeScope: "chat_telegram_one", channel: "telegram", bridgeId: "chat_telegram_one",
      chatSessionId: "room", lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    });
    await assert.rejects(() => current.database.chatSessions.put({
      id: "chat_telegram_one:room-duplicate", routeScope: "chat_telegram_one", channel: "telegram", bridgeId: "chat_telegram_one",
      chatSessionId: "room", lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    }), (error: any) => error.code === "CONTROL_PLANE_DATABASE_UNIQUE_CONFLICT" && error.statusCode === 409);
    await assert.rejects(() => current.database.chatSessions.put({
      id: "missing:room", routeScope: "missing", channel: "telegram", bridgeId: "missing", chatSessionId: "room",
      lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
    }), (error: any) => error.code === "CONTROL_PLANE_DATABASE_FOREIGN_KEY_CONFLICT" && error.statusCode === 409);

    await assert.rejects(() => current.database.transaction(async (transaction) => {
      await transaction.models.put({
        id: "model_z", name: "Z", endpoint: "https://models.example.com", keyCiphertext: current.secret.seal("key", "model:model_z:key"),
        model: "z", modelNames: [{ name: "z", order: 100 }], protocols: ["openai-responses"], app: "codex",
        enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
      });
      throw new Error("force P0 rollback");
    }), /force P0 rollback/);
    assert.equal(await current.database.models.get("model_z"), undefined);

    await current.database.models.put({
      id: "model_b", name: "B", endpoint: "https://models.example.com", keyCiphertext: current.secret.seal("key", "model:model_b:key"),
      model: "b", modelNames: [{ name: "b", order: 100 }], protocols: ["openai-responses"], app: "codex",
      enabled: true, order: 200, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    await current.database.models.put({
      id: "model_a", name: "A", endpoint: "https://models.example.com", keyCiphertext: current.secret.seal("key", "model:model_a:key"),
      model: "a", modelNames: [{ name: "a", order: 100 }], protocols: ["openai-responses"], app: "codex",
      enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    assert.deepEqual((await current.database.models.list()).map((model) => model.id), ["model_a", "model_b"]);

    await current.database.transaction((outer) => outer.transaction(async (inner) => {
      await inner.nodes.put({
        id: "node_nested", name: "Nested", connectionMode: "reverse-wss", connectionPath: { kind: "direct" }, connectionEnabled: true,
        authMode: "paired-hmac", labels: {}, createdAt: timestamp, updatedAt: timestamp,
      });
    }));
    await Promise.all([
      current.database.nodes.put({ ...(await current.database.nodes.get("node_nested"))!, name: "Concurrent A", updatedAt: new Date(Date.now() + 1).toISOString() }),
      current.database.nodes.put({ ...(await current.database.nodes.get("node_nested"))!, name: "Concurrent B", updatedAt: new Date(Date.now() + 2).toISOString() }),
    ]);
    assert.ok(["Concurrent A", "Concurrent B"].includes((await current.database.nodes.get("node_nested"))!.name));
  } finally {
    await current.cleanup();
  }
});

test("PostgreSQL P0 contract is opt-in when no test database is configured", { skip: Boolean(postgresqlUrl) }, () => {
  assert.equal(postgresqlUrl, undefined);
});

test("database close rejects new mutations and drains an active transaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-db-drain-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const timestamp = new Date().toISOString();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const transaction = database.transaction(async (current) => {
    await current.models.put({
      id: "model_before_close", name: "Before", endpoint: "https://models.example.com", keyCiphertext: "v1.key_1234567890123456.1234567890123456.cipher.1234567890123456789012",
      model: "before", modelNames: [{ name: "before", order: 100 }], protocols: ["openai-responses"], app: "codex",
      enabled: true, order: 100, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    entered();
    await gate;
    await current.models.put({
      id: "model_after_gate", name: "After", endpoint: "https://models.example.com", keyCiphertext: "v1.key_1234567890123456.1234567890123456.cipher.1234567890123456789012",
      model: "after", modelNames: [{ name: "after", order: 100 }], protocols: ["openai-responses"], app: "codex",
      enabled: true, order: 200, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    });
  });
  await started;
  const closing = database.close();
  await assert.rejects(
    () => database.models.delete("model_before_close"),
    (error: any) => error.code === "CONTROL_PLANE_DATABASE_QUIESCING",
  );
  release();
  await transaction;
  await closing;

  const reopened = await createControlPlaneDatabase(paths);
  try {
    assert.deepEqual((await reopened.models.list()).map((model) => model.id), ["model_after_gate", "model_before_close"]);
  } finally {
    await reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
