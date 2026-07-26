const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");
const { createGitFixture } = require("./fixtures/git-repository.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { RepositoryFileError, RepositoryFileService } = require("../packages/controlled-instance/src/repository/files.ts");

test("repository files list one level and preserve special names", () => {
  const fixture = createGitFixture();
  fixture.write("src/nested.ts", "nested\n");
  fixture.write("空 格\nfile.txt", "special\n");
  const service = new RepositoryFileService(fixture.root);
  const root = service.list();
  assert.equal(root.entries.some((entry) => entry.name === ".git"), false);
  assert.equal(root.entries.find((entry) => entry.name === "src").kind, "directory");
  assert.equal(root.entries.some((entry) => entry.name === "nested.ts"), false);
  assert.equal(root.entries.some((entry) => entry.name === "空 格\nfile.txt"), true);
  assert.deepEqual(service.list("src").entries.map((entry) => entry.name), ["nested.ts"]);
});

test("repository files use the workspace boundary while traversing nested repositories", () => {
  const fixture = createGitFixture();
  const external = path.join(fixture.base, "external.txt");
  fs.writeFileSync(external, "secret\n");
  fs.symlinkSync(external, path.join(fixture.root, "external-link"));
  fs.mkdirSync(path.join(fixture.root, "submodule"));
  fs.writeFileSync(path.join(fixture.root, "submodule", ".git"), "gitdir: ../.git/modules/submodule\n");
  fs.mkdirSync(path.join(fixture.root, "nested", ".git"), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, "nested", "inside.txt"), "nested\n");
  fs.writeFileSync(path.join(fixture.root, "submodule", "inside.txt"), "submodule\n");
  const service = new RepositoryFileService(fixture.root, undefined, fixture.base);
  const invalid = ["/etc/passwd", "../external.txt", "src/../tracked.txt", ".git/config", ".GIT/config", "src//file"];
  for (const value of invalid) assert.throws(() => service.read(value), (error) => error instanceof RepositoryFileError);
  assert.throws(() => service.read("external-link"), (error) => error.code === "REPOSITORY_PATH_FORBIDDEN");
  assert.deepEqual(service.list("submodule").entries.map((entry) => entry.name), ["inside.txt"]);
  assert.deepEqual(service.list("nested").entries.map((entry) => entry.name), ["inside.txt"]);
  const listing = service.list();
  assert.equal(listing.entries.find((entry) => entry.name === "external-link").kind, "symlink");
  assert.equal(listing.entries.find((entry) => entry.name === "submodule").kind, "submodule");
  assert.equal(listing.entries.find((entry) => entry.name === "nested").kind, "nested-repository");
  assert.equal(listing.entries.find((entry) => entry.name === "submodule").traversable, true);
  assert.equal(listing.entries.find((entry) => entry.name === "nested").traversable, true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-outside-workspace-"));
  assert.throws(() => new RepositoryFileService(fixture.root, undefined, outside), (error) => error.code === "REPOSITORY_PATH_FORBIDDEN");
});

test("repository text reads enforce UTF-8, binary, and size boundaries", () => {
  const fixture = createGitFixture();
  fs.writeFileSync(path.join(fixture.root, "binary.dat"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(fixture.root, "invalid.txt"), Buffer.from([0xff, 0xfe]));
  fixture.write("large.txt", "12345");
  const service = new RepositoryFileService(fixture.root, 4);
  assert.throws(() => service.read("binary.dat"), (error) => error.code === "REPOSITORY_FILE_BINARY");
  assert.throws(() => service.read("invalid.txt"), (error) => error.code === "REPOSITORY_FILE_BINARY");
  assert.throws(() => service.read("large.txt"), (error) => error.code === "REPOSITORY_FILE_TOO_LARGE");
});

test("repository create, write, rename, and delete use versions without losing executable mode", () => {
  const fixture = createGitFixture();
  fixture.write("script.sh", "#!/bin/sh\nexit 0\n", 0o755);
  const service = new RepositoryFileService(fixture.root);
  const opened = service.read("script.sh");
  assert.equal(opened.mode.executable, true);
  const saved = service.write("script.sh", "#!/bin/sh\nexit 1\n", opened.version);
  assert.equal(saved.mode.executable, true);
  assert.equal(fs.statSync(path.join(fixture.root, "script.sh")).mode & 0o111, 0o111);
  assert.throws(() => service.write("script.sh", "stale", opened.version), (error) => error.code === "REPOSITORY_FILE_STALE");

  const created = service.create("created.txt", "created\n");
  assert.throws(() => service.create("created.txt", "overwrite\n"), (error) => error.code === "REPOSITORY_FILE_EXISTS");
  const renamed = service.rename("created.txt", "renamed.txt", created.version);
  assert.equal(renamed.content, "created\n");
  assert.equal(fs.existsSync(path.join(fixture.root, "created.txt")), false);
  fixture.write("occupied.txt", "occupied\n");
  assert.throws(() => service.rename("renamed.txt", "occupied.txt", renamed.version), (error) => error.code === "REPOSITORY_FILE_EXISTS");
  fixture.write("renamed.txt", "external change\n");
  assert.throws(() => service.delete("renamed.txt", renamed.version), (error) => error.code === "REPOSITORY_FILE_STALE");
  const latest = service.read("renamed.txt");
  service.delete("renamed.txt", latest.version);
  assert.equal(fs.existsSync(path.join(fixture.root, "renamed.txt")), false);
});
