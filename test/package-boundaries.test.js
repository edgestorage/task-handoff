const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkWorkspace } = require("../bin/check-package-boundaries.js");

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-boundaries-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

function manifest(name, dependencies = {}, exports = { ".": "./src/index.ts" }) {
  return JSON.stringify({ name, dependencies, exports });
}

test("package boundary checker accepts declared public workspace imports", () => {
  const root = fixture({
    "packages/protocol/package.json": manifest("@example/protocol", {}, { ".": "./src/index.ts", "./events": "./src/events.ts" }),
    "packages/protocol/src/events.ts": "export const event = 'ready';",
    "apps/web/package.json": manifest("@example/web", { "@example/protocol": "workspace:*" }),
    "apps/web/src/main.ts": "import { event } from '@example/protocol/events';\nvoid event;",
  });

  assert.deepEqual(checkWorkspace(root), []);
});

test("package boundary checker rejects relative imports across workspace units including CSS", () => {
  const root = fixture({
    "packages/theme/package.json": manifest("@example/theme"),
    "packages/theme/index.css": ":root { --background: white; }",
    "apps/web/package.json": manifest("@example/web"),
    "apps/web/src/app.css": "@import '../../../packages/theme/index.css';",
  });

  assert.match(checkWorkspace(root).join("\n"), /relative import crosses into @example\/theme/);
});

test("package boundary checker rejects imports from ignored EE source", () => {
  const root = fixture({
    "apps/web/package.json": manifest("@example/web"),
    "apps/web/src/main.ts": "import '../../../ee/cloud-platform/packages/contracts/src/index.js';",
  });

  assert.match(checkWorkspace(root).join("\n"), /open-source workspace must not import ignored EE source/);
});

test("package boundary checker rejects package dependencies on apps", () => {
  const root = fixture({
    "apps/server/package.json": manifest("@example/server"),
    "packages/runtime/package.json": manifest("@example/runtime", { "@example/server": "workspace:*" }),
    "packages/runtime/src/index.ts": "export {};",
  });

  assert.match(checkWorkspace(root).join("\n"), /packages must not depend on app @example\/server/);
});

test("package boundary checker rejects undeclared and unexported deep imports", () => {
  const root = fixture({
    "packages/protocol/package.json": manifest("@example/protocol"),
    "packages/protocol/src/private.ts": "export const privateValue = true;",
    "apps/web/package.json": manifest("@example/web", { "@example/protocol": "workspace:*" }),
    "apps/web/src/main.ts": "import '@example/protocol/private';\nimport 'missing-package';",
  });
  const violations = checkWorkspace(root).join("\n");

  assert.match(violations, /@example\/protocol\/private is not exported/);
  assert.match(violations, /imports undeclared dependency missing-package/);
});
