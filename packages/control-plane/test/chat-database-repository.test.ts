import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";
import { ControlPlaneChatRepository, ControlPlaneChatStore } from "../src/control-plane/chat/bridges/repository.ts";
import { ChatBridgeService } from "../src/control-plane/chat/bridges/service.ts";

test("Chat repository encrypts adapter credentials and atomically removes bridge sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-chat-db-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneChatRepository(database, secrets);
  const timestamp = new Date().toISOString();
  try {
    await repository.putBridge({ id: "chat_dingding", channel: "dingding", name: "DingDing", enabled: true, token: "client-id", allowedUserIds: [], pollIntervalMs: 3000, settings: { clientSecret: "client-secret", sessionWebhook: "https://secret.example/hook", robotCode: "robot" }, createdAt: timestamp, updatedAt: timestamp });
    const raw = await database.chatBridges.get("chat_dingding");
    assert.deepEqual(raw?.settings, { robotCode: "robot" });
    assert.ok(raw?.credentialCiphertext?.startsWith("v1.key_"));
    assert.doesNotMatch(raw!.credentialCiphertext!, /client-secret|secret\.example|client-id/);
    const restored = await repository.getBridge("chat_dingding");
    assert.equal(restored?.token, "client-id");
    assert.equal(restored?.settings.clientSecret, "client-secret");
    assert.equal(restored?.settings.robotCode, "robot");

    await repository.putSession({ id: "chat_dingding:room", channel: "dingding", bridgeId: "chat_dingding", chatSessionId: "room", lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    assert.equal(await repository.deleteBridge("chat_dingding"), true);
    assert.equal(await repository.getSession("chat_dingding:room"), undefined);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chat store serializes route upsert and preserves bridge secrets on partial update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-chat-store-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneChatRepository(database, secrets);
  const store = new ControlPlaneChatStore(repository);
  const service = new ChatBridgeService({ store });
  const timestamp = new Date().toISOString();
  try {
    await repository.putBridge({ id: "chat_lark_one", channel: "lark", name: "Lark", enabled: true, token: "app-id", allowedUserIds: [], pollIntervalMs: 3000, settings: { appSecret: "app-secret", domain: "feishu" }, createdAt: timestamp, updatedAt: timestamp });
    await store.init();
    await service.update("chat_lark_one", { name: "Renamed" });
    assert.equal((await repository.getBridge("chat_lark_one"))?.settings.appSecret, "app-secret");
    assert.equal(JSON.stringify(service.list()).includes("app-secret"), false);

    const session = { id: "chat_lark_one:room", channel: "lark" as const, bridgeId: "chat_lark_one", chatSessionId: "room", lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
    await Promise.all([
      store.putSession({ ...session, activeInstanceId: "instance_one" }),
      store.putSession({ ...session, activeInstanceId: "instance_two" }),
    ]);
    assert.equal(store.listSessions().length, 1);
    assert.equal((await database.chatSessions.list()).length, 1);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chat public reads use credential metadata without decrypting bridge secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-chat-public-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneChatRepository(database, secrets);
  const store = new ControlPlaneChatStore(repository);
  const service = new ChatBridgeService({ store });
  const timestamp = new Date().toISOString();
  try {
    await repository.putBridge({ id: "chat_lark_public", channel: "lark", name: "Lark", enabled: true, token: "app-id", allowedUserIds: [], pollIntervalMs: 3000, settings: { appSecret: "app-secret", domain: "feishu" }, createdAt: timestamp, updatedAt: timestamp });
    let decryptions = 0;
    const open = secrets.open.bind(secrets);
    secrets.open = (...args) => {
      decryptions += 1;
      return open(...args);
    };

    await store.init();
    assert.equal(decryptions, 0);
    const listed = service.list()[0]!;
    assert.equal(listed.id, "chat_lark_public");
    assert.equal(listed.tokenSet, true);
    assert.deepEqual(listed.settings, { domain: "feishu", appSecretSet: true });
    assert.doesNotMatch(JSON.stringify(listed), /app-secret|app-id|v1\.key_/);
    assert.equal(service.require("chat_lark_public").token, undefined);
    assert.equal(decryptions, 0);
    assert.equal(service.resolve("chat_lark_public").settings.appSecret, "app-secret");
    assert.equal(decryptions, 1);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chat bridge deletion rolls back with all sessions on transaction failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-chat-rollback-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const timestamp = new Date().toISOString();
  try {
    const repository = new ControlPlaneChatRepository(database, secrets);
    await repository.putBridge({ id: "chat_telegram_one", channel: "telegram", name: "Telegram", enabled: false, token: "token", allowedUserIds: [], pollIntervalMs: 3000, settings: {}, createdAt: timestamp, updatedAt: timestamp });
    await repository.putSession({ id: "chat_telegram_one:room", channel: "telegram", bridgeId: "chat_telegram_one", chatSessionId: "room", lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
    const failing = {
      ...database,
      transaction: <T>(operation: Parameters<typeof database.transaction<T>>[0]) => database.transaction(async (transaction) => {
        await operation(transaction);
        throw new Error("injected Chat delete failure");
      }),
    };
    await assert.rejects(() => new ControlPlaneChatRepository(failing, secrets).deleteBridge("chat_telegram_one"), /injected Chat delete failure/);
    assert.ok(await repository.getBridge("chat_telegram_one"));
    assert.ok(await repository.getSession("chat_telegram_one:room"));
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chat credential codec rejects fields not owned by the adapter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-chat-schema-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneChatRepository(database, secrets);
  const timestamp = new Date().toISOString();
  try {
    await assert.rejects(() => repository.putBridge({ id: "chat_telegram", channel: "telegram", name: "Telegram", enabled: false, token: "token", allowedUserIds: [], pollIntervalMs: 3000, settings: { futureSecret: "unknown" }, createdAt: timestamp, updatedAt: timestamp }), (error: any) => error.code === "CHAT_BRIDGE_SETTINGS_UNSUPPORTED");
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
