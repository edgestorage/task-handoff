const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");

test("packaged child processes do not use app.asar as their cwd", () => {
  assert.equal((main.match(/resolveDesktopRuntimeRoot\(\{ packaged: app\.isPackaged, resourcesPath: process\.resourcesPath, root: repoRoot\(\) \}\)/g) || []).length, 2);
  assert.match(main, /resolveDesktopProcessCwd\(process\.env, \{ packaged: app\.isPackaged, root \}\)/);
  assert.match(main, /fs\.mkdirSync\(processCwd, \{ recursive: true \}\)/);
  assert.doesNotMatch(main, /spawn\(nodeCommand, args, \{\s*cwd: root,/);
  assert.equal((main.match(/cwd: processCwd,/g) || []).length, 2);
});

test("desktop child process spawn failures are handled and surfaced", () => {
  assert.equal((main.match(/child\.on\("error"/g) || []).length, 2);
  assert.match(main, /Control Plane failed to spawn/);
  assert.match(main, /Node agent failed to spawn/);
});

test("node agent receives the bundled controlled-instance command as structured argv", () => {
  assert.match(
    main,
    /TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV: JSON\.stringify\(\[nodeCommand, validation\.cliEntry, "web"\]\)/,
  );
  assert.match(
    main,
    /TASK_HANDOFF_BUNDLED_RUNTIME_DIR: process\.env\.TASK_HANDOFF_BUNDLED_RUNTIME_DIR \|\| path\.join\(root, "release", "runtime-artifacts"\)/,
  );
});
