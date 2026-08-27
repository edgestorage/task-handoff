const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ControlledPrivateModelCatalogSchema,
  readControlledPrivateModelCatalog,
  resolveControlledPrivateModelSelection,
} = require("../packages/controlled-instance/src/web/private-model-catalog.ts");

const catalog = {
  protocolVersion: "2026-08-27",
  instanceId: "inst_one",
  entities: [{
    id: "provider_one",
    endpoint: "https://models.example/v1",
    key: "secret",
    protocols: ["openai-responses"],
    modelNames: [{ name: "model-one", order: 0 }],
  }],
  updatedAt: "2026-08-28T00:00:00.000Z",
};

test("private catalog resolves defaults and rejects stale selections without fallback", () => {
  assert.deepEqual(resolveControlledPrivateModelSelection(catalog, "codex"), {
    modelEntityId: "provider_one",
    modelName: "model-one",
  });
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "removed", modelName: "model-one" }),
    (error) => error.code === "AI_SESSION_MODEL_ENTITY_UNAVAILABLE" && error.statusCode === 409,
  );
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "provider_one", modelName: "removed-model" }),
    (error) => error.code === "AI_SESSION_MODEL_NAME_UNAVAILABLE" && error.statusCode === 409,
  );
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "claude", { modelEntityId: "provider_one", modelName: "model-one" }),
    (error) => error.code === "AI_SESSION_MODEL_ENTITY_UNAVAILABLE" && error.statusCode === 409,
  );
});

test("managed Docker config consumes the catalog loaded before privilege drop", () => {
  const actual = readControlledPrivateModelCatalog({
    TASK_HANDOFF_INSTANCE_ID: "inst_one",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: JSON.stringify(catalog),
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: "/root/unreadable-private-config.json",
  });

  assert.deepEqual(actual, catalog);
});

test("managed Docker config treats an omitted loaded catalog as authoritative", () => {
  const actual = readControlledPrivateModelCatalog({
    TASK_HANDOFF_INSTANCE_ID: "inst_one",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: "/root/unreadable-private-config.json",
  });

  assert.equal(actual, undefined);
});

test("local runtime continues to read the protected private config file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-model-catalog-"));
  const filePath = path.join(directory, "inst_one.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify({ modelCatalog: catalog }), { mode: 0o600 });
    const actual = readControlledPrivateModelCatalog({
      TASK_HANDOFF_INSTANCE_ID: "inst_one",
      TASK_HANDOFF_RUNTIME_KIND: "local",
      TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: filePath,
    });
    assert.deepEqual(actual, catalog);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private catalog ignores unknown fields but rejects corrupt required fields", () => {
  const sanitized = ControlledPrivateModelCatalogSchema.parse({
    ...catalog,
    future: true,
    entities: [{ ...catalog.entities[0], future: true, modelNames: [{ ...catalog.entities[0].modelNames[0], future: true }] }],
  });
  assert.deepEqual(sanitized, catalog);
  assert.equal(ControlledPrivateModelCatalogSchema.safeParse({ ...catalog, protocolVersion: "2026-08-28" }).success, false);
  assert.equal(ControlledPrivateModelCatalogSchema.safeParse({ ...catalog, entities: [{ ...catalog.entities[0], key: undefined }] }).success, false);
});

test("private catalog rejects a mismatched runtime identity without exposing its key", () => {
  assert.throws(() => readControlledPrivateModelCatalog({
    TASK_HANDOFF_INSTANCE_ID: "inst_other",
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: JSON.stringify(catalog),
  }), (error) => {
    assert.equal(error.code, "PRIVATE_MODEL_CATALOG_IDENTITY_MISMATCH");
    assert.equal(String(error.message).includes("secret"), false);
    return true;
  });
});
