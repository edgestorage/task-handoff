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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { registerRepositoryRoutes } = require("../packages/controlled-instance/src/repository/routes.ts");
const { createGitFixture } = require("./fixtures/git-repository.js");
const fixtures = ["repository-query-parity.json", "repository-query-structure-parity.json"].flatMap((file) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures", file), "utf8")));

test("repository request validation matches shared Node/Rust HTTP fixtures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-query-parity-"));
  const app = require("fastify")();
  registerRepositoryRoutes(app, {
    appRuntime: { getSession: () => undefined, listSessions: () => [] },
    aiSessions: { get: () => undefined, boundSnapshot: () => ({ sessions: [] }) },
    aiSessionCreate: { completedResult: () => undefined },
    managedWorktreesRoot: path.join(root, "managed"),
    workspaceRoots: [root],
  });
  try {
    // Valid numbers reach session lookup; invalid numbers fail validation first.
    for (const fixture of fixtures) {
      const response = await app.inject({ method: "GET", url: `/api/ai-sessions/missing/repository/${fixture.suffix}` });
      assert.deepEqual({ status: response.statusCode, error: response.json().error }, fixture.expected, fixture.name);
    }
    const bodies = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures/repository-body-parity.json"), "utf8"));
    for (const fixture of bodies) {
      const response = await app.inject({ method: fixture.method, url: `/api/ai-sessions/missing/repository/${fixture.suffix}`, headers: { "content-type": "application/json" }, payload: JSON.stringify(fixture.body) });
      assert.deepEqual({ status: response.statusCode, error: response.json().error }, fixture.expected, fixture.name);
    }
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository file queries preserve Node path decoding and file identity", async () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures/repository-file-query-parity.json"), "utf8"));
  const repository = createGitFixture();
  const app = require("fastify")();
  registerRepositoryRoutes(app, {
    appRuntime: { getSession: () => undefined, listSessions: () => [] },
    aiSessions: { get: (id) => id === "query-files" ? { cwd: repository.root, status: "running" } : undefined, boundSnapshot: () => ({ sessions: [] }) },
    aiSessionCreate: { completedResult: () => undefined },
    managedWorktreesRoot: path.join(repository.base, "managed"),
    workspaceRoots: [repository.base],
  });
  try {
    for (const fixture of fixtures) {
      if (fixture.fileName) repository.write(fixture.fileName, "file query fixture\n");
      const response = await app.inject({ method: "GET", url: `/api/ai-sessions/query-files/repository/${fixture.suffix}` });
      assert.deepEqual({ status: response.statusCode, ...response.json() }, fixture.expected, fixture.name);
    }
  } finally {
    await app.close();
    fs.rmSync(repository.base, { recursive: true, force: true });
  }
});

test("repository transport honors raw byte limits and media type errors", async () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures/repository-transport-parity.json"), "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-transport-parity-"));
  const app = require("fastify")();
  registerRepositoryRoutes(app, {
    appRuntime: { getSession: () => undefined, listSessions: () => [] },
    aiSessions: { get: () => undefined, boundSnapshot: () => ({ sessions: [] }) },
    aiSessionCreate: { completedResult: () => undefined },
    managedWorktreesRoot: path.join(root, "managed"), workspaceRoots: [root],
  });
  try {
    for (const fixture of fixtures) {
      const payload = fixture.hex ? Buffer.from(fixture.hex, "hex") : (fixture.prefix || "") + fixture.unit.repeat(fixture.repeat);
      const headers = { "content-type": fixture.type, "content-length": fixture.declaredLength ?? Buffer.byteLength(payload) };
      const response = await app.inject({ method: fixture.method, url: `/api/ai-sessions/missing/repository/${fixture.suffix}`, headers, payload });
      assert.deepEqual({ status: response.statusCode, body: response.json() }, fixture.expected, fixture.name);
    }
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
