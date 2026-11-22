import assert from "node:assert/strict";
import test from "node:test";
import { aiSessionActivityDetailInput } from "../src/ai-session-activity-details.ts";

test("detail input preserves supplied input and only uses context for exploration activities", () => {
  const context = { summary: "ready · src", paths: ["src"] };
  for (const activityKind of ["fileRead", "fileSearch", "fileList", "explore", "webSearch"]) {
    assert.equal(aiSessionActivityDetailInput({ activityKind, ...context, input: "rg ready src\n" }), "rg ready src\n");
    assert.equal(aiSessionActivityDetailInput({ activityKind, ...context }), context.summary);
    assert.equal(aiSessionActivityDetailInput({ activityKind, paths: ["a", "b"] }), "a\nb");
  }
  assert.equal(aiSessionActivityDetailInput({ activityKind: "reasoning", ...context }), undefined);
  assert.equal(aiSessionActivityDetailInput({ activityKind: "fileChange", ...context }), undefined);
});
