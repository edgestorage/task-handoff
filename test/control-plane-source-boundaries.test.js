const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const checker = path.join(root, "packages", "control-plane", "scripts", "check-boundaries.mjs");
const packageName = "@fixture/control-plane";

function write(rootDir, relativePath, source) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function fixture() {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-boundaries-"));
  const packageRoot = path.join(repositoryRoot, "packages", "control-plane");
  const nodeAgentRoot = path.join(repositoryRoot, "packages", "node-agent");
  const runtimeSharedRoot = path.join(repositoryRoot, "packages", "runtime-shared");
  write(packageRoot, "package.json", JSON.stringify({
    name: packageName,
    type: "module",
    exports: {
      ".": "./src/index.ts",
      "./service": "./src/service.ts",
    },
  }));
  write(nodeAgentRoot, "package.json", JSON.stringify({ name: "@fixture/node-agent", type: "module" }));
  write(runtimeSharedRoot, "src/value.ts", "export const value = 1;\n");
  write(packageRoot, "src/control-plane/service.ts", "import { value } from \"../../../runtime-shared/src/value.ts\"; export const service = value;\n");
  write(nodeAgentRoot, "src/app.ts", "import { value } from \"../../runtime-shared/src/value.ts\"; export const app = value;\n");
  write(packageRoot, "src/public/store.ts", "export * from \"../../../runtime-shared/src/value.ts\";\n");
  write(packageRoot, "src/service.ts", "export * from \"./control-plane/service.ts\";\n");
  write(packageRoot, "src/index.ts", "export * from \"./service.ts\";\n");
  return packageRoot;
}

function cleanup(packageRoot) {
  fs.rmSync(path.resolve(packageRoot, "../.."), { recursive: true, force: true });
}

function runChecker(packageRoot) {
  return spawnSync(process.execPath, [
    checker,
    "--source-root", path.join(packageRoot, "src"),
    "--package-root", packageRoot,
    "--package-name", packageName,
  ], { encoding: "utf8" });
}

test("control-plane source boundary checker accepts the intended dependency graph", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  const result = runChecker(packageRoot);
  assert.equal(result.status, 0, result.stderr);
});

test("control-plane source boundary checker rejects control-plane imports from node-agent", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(packageRoot, "src/control-plane/service.ts", "import { app } from \"../../node-agent/src/app.ts\"; export const service = app;\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /control-plane modules must only import control-plane or shared modules/);
  assert.match(result.stderr, /src\/control-plane\/service\.ts imports \.\.\/\.\.\/node-agent\/src\/app\.ts/);
});

test("control-plane source boundary checker rejects internal imports through a root facade", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(path.resolve(packageRoot, "../node-agent"), "src/app.ts", "import { service } from \"../../control-plane/src/service.ts\"; export const app = service;\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\.\/node-agent\/src\/app\.ts imports \.\.\/\.\.\/control-plane\/src\/service\.ts/);
});

test("control-plane source boundary checker rejects internal imports through a public facade", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(packageRoot, "src/control-plane/service.ts", "import { value } from \"../public/store.ts\"; export const service = value;\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/control-plane\/service\.ts imports \.\.\/public\/store\.ts/);
});

test("control-plane source boundary checker resolves and rejects own-package subpaths", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(path.resolve(packageRoot, "../node-agent"), "src/app.ts", `import { service } from "${packageName}/service"; export const app = service;\n`);
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${packageName.replace("/", "\\/")}\\/service`));
  assert.match(result.stderr, /src\/service\.ts/);
});

test("control-plane source boundary checker rejects import types that cross a boundary", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(path.resolve(packageRoot, "../runtime-shared"), "src/value.ts", "export type Leaked = typeof import(\"../../control-plane/src/service.ts\");\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\.\/runtime-shared\/src\/value\.ts imports \.\.\/\.\.\/control-plane\/src\/service\.ts/);
});

test("control-plane source boundary checker rejects dynamic imports with attributes that cross a boundary", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(path.resolve(packageRoot, "../node-agent"), "src/app.ts", "export const app = import(\"../../control-plane/src/service.ts\", { with: { type: \"json\" } });\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\.\/node-agent\/src\/app\.ts imports \.\.\/\.\.\/control-plane\/src\/service\.ts/);
});

test("control-plane source boundary checker rejects cross-boundary imports hidden behind symlinks", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  fs.symlinkSync(path.join(packageRoot, "src/control-plane/service.ts"), path.join(packageRoot, "../node-agent/src/linked-service.ts"));
  write(path.resolve(packageRoot, "../node-agent"), "src/app.ts", "import { service } from \"./linked-service.ts\"; export const app = service;\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\.\/node-agent\/src\/app\.ts imports \.\/linked-service\.ts/);
  assert.match(result.stderr, /src\/control-plane\/service\.ts/);
});

test("control-plane source boundary checker parses TSX with the matching script kind", (t) => {
  const packageRoot = fixture();
  t.after(() => cleanup(packageRoot));
  write(path.resolve(packageRoot, "../node-agent"), "src/view.tsx", "export const view = <section>{import(\"../../control-plane/src/service.ts\")}</section>;\n");
  const result = runChecker(packageRoot);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\.\/node-agent\/src\/view\.tsx imports \.\.\/\.\.\/control-plane\/src\/service\.ts/);
});
