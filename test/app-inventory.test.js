const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppCatalogRepository } = require("../packages/app-runtime/src/catalog.ts");

function storagePaths(root) {
  return {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    triggersDir: path.join(root, "triggers"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
}

test("app inventory keeps available and missing custom apps without exposing launch configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-inventory-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, "available-app");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.mkdirSync(path.join(root, "app-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "app-catalog", "custom.json"), JSON.stringify({
    schemaVersion: 1,
    futureTopLevel: true,
    items: [
      {
        id: "available-custom",
        name: "Available Custom",
        kind: "tty",
        command: executable,
        args: ["--token", "secret-value"],
        env: { APP_SECRET: "secret-value" },
        futureItemField: true,
      },
      {
        id: "missing-custom",
        name: "Missing Custom",
        kind: "gui",
        command: path.join(binDir, "missing-app"),
      },
    ],
  }));

  const repository = new AppCatalogRepository(storagePaths(root));
  const inventory = repository.inventory("2026-07-15T00:00:00.000Z");
  const available = inventory.items.find((item) => item.id === "available-custom");
  const missing = inventory.items.find((item) => item.id === "missing-custom");
  assert.equal(available.availability, "available");
  assert.equal(available.source, "custom");
  assert.equal(missing.availability, "missing-dependency");
  assert.equal(missing.diagnosticCode, "APP_EXECUTABLE_NOT_FOUND");
  assert.equal(JSON.stringify(inventory).includes("secret-value"), false);
  assert.equal(JSON.stringify(inventory).includes("APP_SECRET"), false);
  assert.deepEqual(inventory.issues, []);
});

test("app inventory recovers valid custom entries and reports a sanitized issue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-inventory-invalid-"));
  const appCatalogDir = path.join(root, "app-catalog");
  fs.mkdirSync(appCatalogDir, { recursive: true });
  fs.writeFileSync(path.join(appCatalogDir, "custom.json"), JSON.stringify({
    schemaVersion: 1,
    items: [
      { id: "valid-custom", name: "Valid Custom", kind: "tty", command: "/definitely/missing" },
      { id: "invalid custom", name: "Invalid Custom", kind: "tty", command: "/bin/sh" },
    ],
  }));
  const repository = new AppCatalogRepository(storagePaths(root));
  const first = repository.inventory("2026-07-15T00:00:00.000Z");
  const second = repository.inventory("2026-07-15T00:00:01.000Z");
  assert.equal(first.items.some((item) => item.id === "valid-custom"), true);
  assert.equal(first.items.some((item) => item.id === "invalid custom"), false);
  assert.deepEqual(first.issues, [{
    code: "APP_CATALOG_INVALID",
    message: "Custom app catalog could not be read completely; valid catalog entries remain available.",
  }]);
  assert.equal(second.observedAt, "2026-07-15T00:00:01.000Z");
  assert.deepEqual(second.items, first.items);

  repository.saveCustom({ schemaVersion: 1, items: [{ id: "new-custom", name: "New Custom", kind: "tty", command: "/definitely/missing" }] });
  const updated = repository.inventory("2026-07-15T00:00:02.000Z");
  assert.equal(updated.items.some((item) => item.id === "valid-custom"), false);
  assert.equal(updated.items.some((item) => item.id === "new-custom"), true);
  assert.deepEqual(updated.issues, []);
});
