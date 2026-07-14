const assert = require("node:assert/strict");
const test = require("node:test");

const { relativeNodePathSegments, resolveNodePath } = require("../packages/control-plane/src/node-path.ts");

test("node paths resolve with the selected node platform semantics", () => {
  assert.equal(resolveNodePath("/workspace/../project"), "/project");
  assert.equal(resolveNodePath("C:\\workspace\\..\\project"), "C:\\project");
});

test("node path relatives support POSIX and Windows independently of the control-plane platform", () => {
  assert.deepEqual(relativeNodePathSegments("/workspace", "/workspace/project/src"), ["project", "src"]);
  assert.deepEqual(relativeNodePathSegments("/", "/Users/me"), ["Users", "me"]);
  assert.equal(relativeNodePathSegments("/workspace", "/workspace-other"), undefined);

  assert.deepEqual(relativeNodePathSegments("c:\\workspace", "C:\\WORKSPACE\\Project\\src"), ["Project", "src"]);
  assert.equal(relativeNodePathSegments("C:\\workspace", "D:\\workspace"), undefined);
  assert.equal(relativeNodePathSegments("C:\\workspace", "/workspace"), undefined);
});
