const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const Fastify = require("fastify");
const { registerRepositoryRoutes } = require("../packages/controlled-instance/src/repository/routes.ts");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-content-"));
  const app = Fastify();
  registerRepositoryRoutes(app, {
    appRuntime: { getSession: () => ({ workspace: { cwd: root }, status: "running" }), listSessions: () => [] },
    aiSessions: { get: (id) => id === "session" ? { cwd: root, status: "idle" } : undefined },
    aiSessionCreate: {}, managedWorktreesRoot: path.join(root, "managed"), workspaceRoots: [root],
  });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, url: (file, kind = "ai-sessions") => `/api/${kind}/session/repository/files/content?${new URLSearchParams({ path: file })}` };
}

test("raw repository media supports HEAD and byte ranges without the text-file size limit", async (t) => {
  const { root, app, url } = await fixture(t);
  const size = 5 * 1024 * 1024;
  fs.writeFileSync(path.join(root, "movie.mp4"), Buffer.alloc(size, 0x7f));
  const head = await app.inject({ method: "HEAD", url: url("movie.mp4") });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-type"], "video/mp4");
  assert.equal(Number(head.headers["content-length"]), size);
  assert.equal(head.body, "");
  assert.equal(head.headers["accept-ranges"], "bytes");
  assert.equal(head.headers["cache-control"], "private, no-store");

  for (const kind of ["ai-sessions", "apps/sessions"]) {
    const range = await app.inject({ url: url("movie.mp4", kind), headers: { range: "bytes=10-19" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-range"], `bytes 10-19/${size}`);
    assert.deepEqual(range.rawPayload, Buffer.alloc(10, 0x7f));
  }
  const suffix = await app.inject({ url: url("movie.mp4"), headers: { range: "bytes=-5" } });
  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.rawPayload.length, 5);
  const invalid = await app.inject({ url: url("movie.mp4"), headers: { range: `bytes=${size + 1}-` } });
  assert.equal(invalid.statusCode, 416);
});

test("raw repository content preserves binary bytes and special filenames", async (t) => {
  const { root, app, url } = await fixture(t);
  const name = "空 格 #%.png";
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  fs.writeFileSync(path.join(root, name), bytes);
  const response = await app.inject({ url: url(name) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["content-security-policy"], /sandbox/);
  assert.deepEqual(response.rawPayload, bytes);
});

test("raw content enforces the same session, path, metadata and symlink boundaries as text reads", async (t) => {
  const { root, app, url } = await fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "secret");
  fs.mkdirSync(path.join(root, "folder"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
  for (const file of ["../outside", ".git/config", "outside/secret", "/etc/passwd"]) {
    const response = await app.inject({ url: url(file) });
    assert.notEqual(response.statusCode, 200, file);
    assert.match(response.json().error.code, /^REPOSITORY_/);
  }
  const missing = await app.inject({ url: url("missing.png") });
  assert.equal(missing.json().error.code, "REPOSITORY_FILE_NOT_FOUND");
  const directory = await app.inject({ url: url("folder") });
  assert.equal(directory.json().error.code, "REPOSITORY_FILE_UNSUPPORTED");
  const inactive = await app.inject({ url: url("missing.png").replace("/session/", "/unknown/") });
  assert.equal(inactive.json().error.code, "REPOSITORY_SESSION_NOT_FOUND");
});
