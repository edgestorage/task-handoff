const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ControlledPrivateModelCatalogSchema,
  readControlledPrivateCodexSettings,
  readControlledPrivateModelCatalog,
  readControlledPrivateModelCatalogSource,
  resolveControlledPrivateModelSelection,
} = require("../packages/controlled-instance/src/web/private-model-catalog.ts");
const { summarizeInstancePrivateModelCatalog } = require("../packages/core/src/core/instance-private-model-catalog.ts");

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
    modelUpstreamName: "model-one",
  });
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "removed", modelName: "model-one" }),
    (error) => error.code === "AI_SESSION_MODEL_ENTITY_UNAVAILABLE"
      && error.statusCode === 409
      && error.message.includes("Select another model"),
  );
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "provider_one", modelName: "removed-model" }),
    (error) => error.code === "AI_SESSION_MODEL_NAME_UNAVAILABLE"
      && error.statusCode === 409
      && error.message.includes("Select another model"),
  );
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "claude", { modelEntityId: "provider_one", modelName: "model-one" }),
    (error) => error.code === "AI_SESSION_MODEL_ENTITY_UNAVAILABLE" && error.statusCode === 409,
  );
});

test("a switch target is never reported as the model previously selected for the session", () => {
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "removed", modelName: "model-one" }, { intent: "target" }),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE"
      && error.statusCode === 409
      && !error.message.includes("previously selected"),
  );
  assert.throws(
    () => resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "provider_one", modelName: "removed-model" }, { intent: "target" }),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE" && error.statusCode === 409,
  );
  assert.deepEqual(
    resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: "provider_one", modelName: "model-one" }, { intent: "target" }),
    { modelEntityId: "provider_one", modelName: "model-one", modelUpstreamName: "model-one" },
  );
});

test("renaming a display label keeps resolving a stored selection by its stable identity", () => {
  const renamed = {
    ...catalog,
    entities: [{
      ...catalog.entities[0],
      modelNames: [{ name: "model-one-renamed", upstreamName: "model-one", order: 0 }],
    }],
  };
  // A session recorded before the rename carries the old label plus the stable
  // identity; it must resolve and report the entry's current label.
  assert.deepEqual(
    resolveControlledPrivateModelSelection(renamed, "codex", {
      modelEntityId: "provider_one",
      modelName: "model-one",
      modelUpstreamName: "model-one",
    }),
    { modelEntityId: "provider_one", modelName: "model-one-renamed", modelUpstreamName: "model-one" },
  );
});

test("a client may select a model by its stable upstream name instead of the display label", () => {
  const renamed = {
    ...catalog,
    entities: [{
      ...catalog.entities[0],
      modelNames: [{ name: "pretty-label", upstreamName: "upstream-id", order: 0 }],
    }],
  };
  assert.deepEqual(
    resolveControlledPrivateModelSelection(renamed, "codex", { modelEntityId: "provider_one", modelName: "upstream-id" }),
    { modelEntityId: "provider_one", modelName: "pretty-label", modelUpstreamName: "upstream-id" },
  );
});

test("the stable upstream name wins when a label collides with another entry's identity", () => {
  const colliding = {
    ...catalog,
    entities: [{
      ...catalog.entities[0],
      modelNames: [
        { name: "shared", upstreamName: "upstream-a", order: 0 },
        { name: "upstream-a", upstreamName: "shared", order: 1 },
      ],
    }],
  };
  assert.deepEqual(
    resolveControlledPrivateModelSelection(colliding, "codex", { modelEntityId: "provider_one", modelName: "shared" }),
    { modelEntityId: "provider_one", modelName: "upstream-a", modelUpstreamName: "shared" },
  );
});

test("catalog diagnostics project identities without credential material", () => {
  const summary = summarizeInstancePrivateModelCatalog(catalog);
  assert.deepEqual(summary, {
    protocolVersion: "2026-08-27",
    instanceId: "inst_one",
    updatedAt: "2026-08-28T00:00:00.000Z",
    entities: [{ id: "provider_one", protocols: ["openai-responses"], modelNames: [{ name: "model-one", order: 0 }] }],
  });
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("catalog source reports where the running instance loaded its models from", () => {
  assert.deepEqual(readControlledPrivateModelCatalogSource({
    TASK_HANDOFF_INSTANCE_ID: "inst_one",
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: JSON.stringify(catalog),
  }), { catalog, source: "environment" });
  assert.deepEqual(readControlledPrivateModelCatalogSource({
    TASK_HANDOFF_INSTANCE_ID: "inst_one",
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  }), { catalog: undefined, source: "none" });
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

test("managed Docker config consumes Codex settings loaded before privilege drop", () => {
  const settings = readControlledPrivateCodexSettings({
    TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
    TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON: JSON.stringify({
      modelVerbosity: "high",
      multiAgent: { enabled: true, maxConcurrentThreads: 4, future: true },
      future: true,
    }),
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: "/root/unreadable-private-config.json",
  });

  assert.deepEqual(settings, {
    modelVerbosity: "high",
    multiAgent: { enabled: true, maxConcurrentThreads: 4 },
  });
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

test("model selection projection matches the shared Node/Rust fixture", () => {
  const parityCatalog = {
    protocolVersion: "2026-08-27",
    instanceId: "ins_0000000000000",
    entities: [{
      id: "model-primary",
      endpoint: "https://models.example/v1",
      key: "secret",
      protocols: ["openai-responses"],
      modelNames: [
        { name: "Primary Label", upstreamName: "upstream-primary", order: 0 },
        { name: "Secondary Label", upstreamName: "upstream-secondary", order: 1 },
      ],
    }],
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
  const renamed = {
    ...parityCatalog,
    entities: [{
      ...parityCatalog.entities[0],
      modelNames: [
        { name: "Renamed Primary", upstreamName: "upstream-primary", order: 0 },
        parityCatalog.entities[0].modelNames[1],
      ],
    }],
  };
  const colliding = {
    ...parityCatalog,
    entities: [{
      ...parityCatalog.entities[0],
      modelNames: [
        { name: "shared", upstreamName: "upstream-a", order: 0 },
        { name: "upstream-a", upstreamName: "shared", order: 1 },
      ],
    }],
  };
  const scenario = (name, requested, intent, current = parityCatalog) => {
    try {
      return {
        name,
        result: resolveControlledPrivateModelSelection(current, "codex", requested, intent ? { intent } : {}) ?? null,
      };
    } catch (error) {
      return { name, error: { code: error.code, statusCode: error.statusCode, message: error.message } };
    }
  };
  const summary = summarizeInstancePrivateModelCatalog(parityCatalog);
  const actual = {
    scenarios: [
      scenario("default"),
      { name: "unsupported-agent", result: resolveControlledPrivateModelSelection(parityCatalog, "unknown") ?? null },
      scenario("renamed-session", { modelEntityId: "model-primary", modelName: "Primary Label", modelUpstreamName: "upstream-primary" }, undefined, renamed),
      scenario("upstream-client-name", { modelEntityId: "model-primary", modelName: "upstream-primary" }, undefined, renamed),
      scenario("colliding-identity-wins", { modelEntityId: "model-primary", modelName: "shared" }, undefined, colliding),
      scenario("stale-entity-target", { modelEntityId: "removed", modelName: "Primary Label" }, "target"),
      scenario("stale-entity-session", { modelEntityId: "removed", modelName: "Primary Label" }, "session"),
      scenario("stale-name-target", { modelEntityId: "model-primary", modelName: "removed-model" }, "target"),
      scenario("stale-name-session", { modelEntityId: "model-primary", modelName: "removed-model" }, "session"),
    ],
    summary,
    summaryLeaksKey: JSON.stringify(summary).includes("secret"),
  };
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "controlled-instance-rs", "crates", "instance", "tests", "fixtures", "private-model-selection-parity.json"), "utf8"));
  assert.deepEqual(actual, fixture);
});

test("private model catalog source and identity errors match the shared fixture", () => {
  const parityCatalog = {
    protocolVersion: "2026-08-27",
    instanceId: "ins_0000000000000",
    entities: [{
      id: "model-primary",
      endpoint: "https://models.example/v1",
      key: "secret",
      protocols: ["openai-responses"],
      modelNames: [{ name: "Primary Label", upstreamName: "upstream-primary", order: 0 }],
    }],
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-model-source-parity-"));
  const filePath = path.join(directory, "private-config.json");
  fs.writeFileSync(filePath, JSON.stringify({ modelCatalog: parityCatalog }), { mode: 0o600 });
  try {
    const normalize = ({ catalog: loaded, source }) => ({
      source,
      catalog: loaded ? {
        instanceId: loaded.instanceId,
        entityIds: loaded.entities.map((entity) => entity.id),
        hasKey: JSON.stringify(loaded).includes("secret"),
      } : null,
    });
    const actual = {
      sources: [
        normalize(readControlledPrivateModelCatalogSource({
          TASK_HANDOFF_INSTANCE_ID: "ins_0000000000000",
          TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: JSON.stringify(parityCatalog),
        })),
        normalize(readControlledPrivateModelCatalogSource({
          TASK_HANDOFF_INSTANCE_ID: "ins_0000000000000",
          TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
        })),
        normalize(readControlledPrivateModelCatalogSource({
          TASK_HANDOFF_INSTANCE_ID: "ins_0000000000000",
          TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: filePath,
        })),
      ],
    };
    try {
      readControlledPrivateModelCatalogSource({
        TASK_HANDOFF_INSTANCE_ID: "ins_other",
        TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: JSON.stringify(parityCatalog),
      });
      assert.fail("identity mismatch must fail");
    } catch (error) {
      actual.identityMismatch = {
        code: error.code,
        message: error.message,
        leaksKey: String(error.message).includes("secret"),
      };
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "controlled-instance-rs", "crates", "instance", "tests", "fixtures", "private-model-source-parity.json"), "utf8"));
    assert.deepEqual(actual, fixture);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
