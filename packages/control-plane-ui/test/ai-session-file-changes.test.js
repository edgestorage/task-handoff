import assert from "node:assert/strict";
import test from "node:test";
import { aiSessionFileChanges, parseAiSessionDiff } from "../src/components/ai-session/aiSessionFileChanges.ts";

function activity(input = {}) {
  return {
    id: "change-1",
    turnId: "turn-1",
    type: "activity",
    activityKind: "fileChange",
    title: "File change",
    ...input,
  };
}

test("normalizes Codex fileChange output without adding a public protocol model", () => {
  const changes = aiSessionFileChanges(activity({
    output: JSON.stringify([{
      path: "/workspace/src/old.ts",
      kind: { type: "move", move_path: "/workspace/src/new.ts" },
      diff: "@@ -1 +1 @@\n-old\n+new",
    }]),
  }));
  assert.deepEqual(changes, [{
    path: "/workspace/src/old.ts",
    movePath: "/workspace/src/new.ts",
    kind: "move",
    diff: "@@ -1 +1 @@\n-old\n+new",
  }]);
});

test("normalizes OpenCode patch metadata and raw edit diffs", () => {
  const structured = aiSessionFileChanges(activity({
    input: JSON.stringify([{ filePath: "/workspace/a.ts", relativePath: "a.ts", type: "update", patch: "-old\n+new" }]),
  }));
  assert.deepEqual(structured, [{ path: "/workspace/a.ts", kind: "update", diff: "-old\n+new" }]);

  const raw = aiSessionFileChanges(activity({ paths: ["/workspace/b.ts"], input: "-before\n+after" }));
  assert.deepEqual(raw, [{ path: "/workspace/b.ts", diff: "-before\n+after" }]);
});

test("renders Codex added and deleted files from their full content", () => {
  const added = aiSessionFileChanges(activity({
    output: JSON.stringify([{ path: "/workspace/new.ts", kind: { type: "add" }, diff: "line one\nline two\n" }]),
  }));
  assert.deepEqual(added, [{ path: "/workspace/new.ts", kind: "add", diff: "@@ -0,0 +1,2 @@\n+line one\n+line two" }]);
  assert.deepEqual(parseAiSessionDiff(added[0].diff), [
    { kind: "addition", content: "line one", newLine: 1 },
    { kind: "addition", content: "line two", newLine: 2 },
  ]);

  const removed = aiSessionFileChanges(activity({
    output: JSON.stringify([{ path: "/workspace/old.ts", kind: { type: "delete" }, diff: "line one\nline two" }]),
  }));
  assert.deepEqual(removed, [{ path: "/workspace/old.ts", kind: "delete", diff: "@@ -1,2 +0,0 @@\n-line one\n-line two" }]);
  assert.deepEqual(parseAiSessionDiff(removed[0].diff), [
    { kind: "deletion", content: "line one", oldLine: 1 },
    { kind: "deletion", content: "line two", oldLine: 2 },
  ]);
});

test("reads nested Codex file change content and unified diffs", () => {
  const added = aiSessionFileChanges(activity({
    output: JSON.stringify([{ path: "/workspace/new.ts", kind: { type: "add", content: "hello\n" } }]),
  }));
  assert.deepEqual(added, [{ path: "/workspace/new.ts", kind: "add", diff: "@@ -0,0 +1,1 @@\n+hello" }]);

  const updated = aiSessionFileChanges(activity({
    output: JSON.stringify([{ path: "/workspace/a.ts", kind: { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new" } }]),
  }));
  assert.deepEqual(updated, [{ path: "/workspace/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }]);
});

test("parses unified diff line numbers while excluding patch metadata", () => {
  const lines = parseAiSessionDiff([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,2 +10,3 @@",
    " same",
    "-before",
    "+after",
    "+extra",
    "",
  ].join("\n"));
  assert.deepEqual(lines, [
    { kind: "context", content: "same", oldLine: 10, newLine: 10 },
    { kind: "deletion", content: "before", oldLine: 11 },
    { kind: "addition", content: "after", newLine: 11 },
    { kind: "addition", content: "extra", newLine: 12 },
  ]);
});

test("does not reinterpret unrelated activity text as file changes", () => {
  assert.deepEqual(aiSessionFileChanges(activity({ input: "plain input", output: "plain output", paths: ["/workspace/a.ts"] })), []);
  assert.deepEqual(aiSessionFileChanges({ ...activity({ input: "-a\n+b", paths: ["/workspace/a.ts"] }), activityKind: "commandExecution" }), []);
});

test("keeps path-only Codex changes out of the raw JSON fallback", () => {
  const changes = aiSessionFileChanges(activity({ output: JSON.stringify([{ path: "/workspace/empty.ts", kind: { type: "update" } }]) }));
  assert.deepEqual(changes, [{ path: "/workspace/empty.ts", kind: "update", diff: "" }]);
});
