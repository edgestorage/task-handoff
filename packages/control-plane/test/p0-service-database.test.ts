import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

test("P0 services restore from the shared database without creating JSON stores", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-p0-service-"));
  const paths = controlPlaneStorePaths(root);
  const timestamp = "2026-08-01T00:00:00.000Z";
  let database = await createControlPlaneDatabase(paths);
  let secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const diagnosticLogs: unknown[] = [];
  const logger = {
    info: (data: unknown, message?: string) => diagnosticLogs.push({ data, message }),
    warn: (data: unknown, message?: string) => diagnosticLogs.push({ data, message }),
    error: (data: unknown, message?: string) => diagnosticLogs.push({ data, message }),
  };
  let service = new ControlPlaneService(paths, { database, secrets, logger });
  try {
    await service.init();
    await service.nodes.put({
      id: "node_one", name: "Node One", connectionMode: "reverse-wss", connectionPath: { kind: "direct" },
      connectionEnabled: true, auth: { mode: "paired-hmac", keyId: "key_one", secret: "node-secret", pairedAt: timestamp, pairing: { status: "paired" } },
      status: "unknown", health: "unknown", capabilities: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    });
    const model = await service.createModel({ name: "Model One", endpoint: "https://models.example.com/v1", key: "model-secret", model: "gpt-one", app: "codex" });
    const modelTwo = await service.createModel({ name: "Model Two", endpoint: "https://models.example.com/v1", key: "model-secret-two", model: "gpt-two", app: "codex" });
    const modelThree = await service.createModel({ name: "Model Three", endpoint: "https://models.example.com/v1", key: "model-secret-three", model: "gpt-three", app: "codex" });
    await Promise.all([
      service.reorderModels([model.id, modelTwo.id, modelThree.id]),
      service.reorderModels([modelThree.id, modelTwo.id, model.id]),
    ]);
    const orderedIds = service.listModels().map((item) => item.id);
    assert.ok([
      [model.id, modelTwo.id, modelThree.id],
      [modelThree.id, modelTwo.id, model.id],
    ].some((candidate) => candidate.every((id, index) => orderedIds[index] === id)));
    assert.deepEqual([...new Set(service.listModels().map((item) => item.order))], [100, 200, 300]);
    const bridge = await service.createChatBridge({ channel: "telegram", name: "Telegram", token: "chat-secret" });
    await service.upsertChatSession({ channel: "telegram", bridgeId: bridge.id, chatSessionId: "room-one" });
    const credential = await service.gitCredentials.create({ name: "Git One", scope: { scheme: "https", host: "git.example.com" }, secret: { kind: "https-token", username: "git", token: "git-secret" } });

    service.dispose();
    await database.close();
    database = await createControlPlaneDatabase(paths);
    secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
    secrets.init();
    service = new ControlPlaneService(paths, { database, secrets, logger });
    await service.init();

    assert.equal(service.listPublicNodes()[0]?.id, "node_one");
    assert.equal(JSON.stringify(service.listPublicNodes()).includes("node-secret"), false);
    assert.equal(service.listModels().length, 3);
    assert.equal(JSON.stringify(service.listModels()).includes("model-secret"), false);
    assert.equal(service.listChatBridges()[0]?.id, bridge.id);
    assert.equal(service.listChatBridges()[0]?.tokenSet, true);
    assert.equal(service.listChatSessions()[0]?.chatSessionId, "room-one");
    assert.equal(service.gitCredentials.get(credential.id)?.id, credential.id);
    assert.equal(JSON.stringify(service.gitCredentials.list()).includes("git-secret"), false);

    let structuredError: unknown;
    try {
      await service.updateChatBridge(bridge.id, { settings: { unsupportedField: "chat-error-secret" } });
    } catch (error) {
      structuredError = error;
    }
    const ciphertexts = [
      (await database.nodes.get("node_one"))?.authSecretCiphertext,
      ...(await database.models.list()).map((record) => record.keyCiphertext),
      (await database.chatBridges.get(bridge.id))?.credentialCiphertext,
      (await database.gitCredentials.get(credential.id))?.secretCiphertext,
    ].filter((value): value is string => Boolean(value));
    const publicAndDiagnosticSurfaces = {
      api: {
        nodes: service.listPublicNodes(),
        models: service.listModels(),
        chatBridges: service.listChatBridges(),
        chatSessions: service.listChatSessions(),
        gitCredentials: service.gitCredentials.list(),
      },
      events: [
        { type: "node.created", payload: { nodeId: "node_one" } },
        { type: "model.created", payload: { modelId: model.id } },
      ],
      logs: diagnosticLogs,
      error: structuredError instanceof Error
        ? { name: structuredError.name, message: structuredError.message, code: (structuredError as { code?: unknown }).code, details: (structuredError as { details?: unknown }).details }
        : structuredError,
      audit: await database.gitAudit.list(),
      ledger: await Promise.all(["0001_user_access", "0002_p0_persistence", "0003_p0_pairing_revoke_phase", "0004_p0_chat_credential_metadata"].map((id) => database.migration(id))),
    };
    const serializedSurfaces = JSON.stringify(publicAndDiagnosticSurfaces);
    for (const secret of ["node-secret", "model-secret", "model-secret-two", "model-secret-three", "chat-secret", "chat-error-secret", "git-secret", ...ciphertexts]) {
      assert.equal(serializedSurfaces.includes(secret), false, `${secret} leaked through a public or diagnostic surface`);
    }
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.databasePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.databaseEncryptionKeyPath).mode & 0o777, 0o600);
    for (const sidecar of [`${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
      if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
    }

    for (const directory of [paths.nodesDir, paths.pendingPairingRevokesDir, paths.modelsDir, paths.chatBridgesDir, paths.chatSessionsDir, path.dirname(paths.gitCredentialsDir)]) {
      assert.equal(fs.existsSync(directory), false, `${path.relative(root, directory)} must not be initialized in database mode`);
    }
  } finally {
    service.dispose();
    await database.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
