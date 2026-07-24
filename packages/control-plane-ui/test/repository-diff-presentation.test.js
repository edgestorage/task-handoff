import assert from "node:assert/strict";
import test from "node:test";
import { createSplitRows, diffPresentationRows } from "../src/apps/control-plane/instance-detail/repositoryDiffPresentation.ts";

function line(kind, content, numbers = {}) {
  return { kind, content, highlighted: content, ...numbers };
}

function contextLines(start, count) {
  return Array.from({ length: count }, (_, index) => ({ kind: "context", content: `line ${start + index}`, oldLine: start + index, newLine: start + index }));
}

test("split rows align inserted lines without shifting related replacements", () => {
  const rows = createSplitRows([
    line("deletion", "const alpha = 1", { oldLine: 1 }),
    line("deletion", "const beta = 2", { oldLine: 2 }),
    line("addition", "const inserted = 0", { newLine: 1 }),
    line("addition", "const alpha = 3", { newLine: 2 }),
    line("addition", "const beta = 2", { newLine: 3 }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].oldLine, undefined);
  assert.equal(rows[0].newLine.content, "const inserted = 0");
  assert.equal(rows[1].oldLine.content, "const alpha = 1");
  assert.equal(rows[1].newLine.content, "const alpha = 3");
  assert.equal(rows[2].oldLine.content, "const beta = 2");
  assert.equal(rows[2].newLine.content, "const beta = 2");
});

test("top and bottom gaps use the same shared expansion model", () => {
  const hunk = { kind: "hunk", content: "@@ -4 +4 @@", hunkId: "hunk:4:1:4:1" };
  const topGap = { gapId: `gap:start:${hunk.hunkId}`, afterHunkId: hunk.hunkId, lines: contextLines(3, 1), startLineCount: 0, hasMore: false };
  const bottomGap = { gapId: `gap:${hunk.hunkId}:end`, beforeHunkId: hunk.hunkId, lines: contextLines(5, 1), startLineCount: 1, hasMore: false };
  const diff = {
    lines: [hunk, { kind: "deletion", content: "old", oldLine: 4 }, { kind: "addition", content: "new", newLine: 4 }],
    contextGaps: [topGap, bottomGap],
  };

  const collapsed = diffPresentationRows(diff, new Map());
  assert.deepEqual(collapsed.map((item) => item.kind), ["context-control", "deletion", "addition", "context-control"]);
  assert.deepEqual(collapsed[0].controls.map((item) => [item.direction, item.lineCount]), [["up", 1]]);
  assert.deepEqual(collapsed[3].controls.map((item) => [item.direction, item.lineCount]), [["down", 1]]);

  const topExpanded = diffPresentationRows(diff, new Map([[topGap.gapId, { fromStart: 0, fromEnd: 1 }]]));
  assert.deepEqual(topExpanded.map((item) => item.content || item.kind), ["line 3", "old", "new", "context-control"]);

  const bottomExpanded = diffPresentationRows(diff, new Map([[bottomGap.gapId, { fromStart: 1, fromEnd: 0 }]]));
  assert.deepEqual(bottomExpanded.map((item) => item.content || item.kind), ["context-control", "old", "new", "line 5"]);
});

test("the first boundary stays above each loaded batch of upward context", () => {
  const hunk = { kind: "hunk", content: "@@ -70 +70 @@", hunkId: "hunk:70:1:70:1" };
  const gap = { gapId: `gap:start:${hunk.hunkId}`, afterHunkId: hunk.hunkId, lines: contextLines(10, 60), startLineCount: 0, hasMore: true };
  const diff = {
    lines: [hunk, { kind: "deletion", content: "old", oldLine: 70 }, { kind: "addition", content: "new", newLine: 70 }],
    contextGaps: [gap],
  };

  for (const expandedLineCount of [20, 40]) {
    const rows = diffPresentationRows(diff, new Map([[gap.gapId, { fromStart: 0, fromEnd: expandedLineCount }]]));
    assert.equal(rows[0].kind, "context-control");
    assert.equal(rows[0].controls[0].direction, "up");
    assert.deepEqual(
      rows.slice(1, expandedLineCount + 1).map((item) => item.newLine),
      Array.from({ length: expandedLineCount }, (_, index) => 70 - expandedLineCount + index),
    );
  }
});

test("a shared middle gap of at most twenty lines expands completely from either direction", () => {
  const firstHunk = { kind: "hunk", content: "@@ -10 +10 @@", hunkId: "hunk:10:1:10:1" };
  const secondHunk = { kind: "hunk", content: "@@ -30 +30 @@", hunkId: "hunk:30:1:30:1" };
  const gap = {
    gapId: `gap:${firstHunk.hunkId}:${secondHunk.hunkId}`,
    beforeHunkId: firstHunk.hunkId,
    afterHunkId: secondHunk.hunkId,
    lines: contextLines(14, 10),
    startLineCount: 5,
    hasMore: false,
  };
  const diff = {
    lines: [
      firstHunk,
      { kind: "deletion", content: "first old", oldLine: 10 },
      { kind: "addition", content: "first new", newLine: 10 },
      secondHunk,
      { kind: "deletion", content: "second old", oldLine: 30 },
      { kind: "addition", content: "second new", newLine: 30 },
    ],
    contextGaps: [gap],
  };

  const collapsed = diffPresentationRows(diff, new Map());
  const boundary = collapsed.find((item) => item.kind === "context-control");
  assert.deepEqual(boundary.controls.map((item) => [item.direction, item.lineCount]), [["up", 10], ["down", 10]]);

  for (const expansion of [{ fromStart: 0, fromEnd: 10 }, { fromStart: 10, fromEnd: 0 }]) {
    const expanded = diffPresentationRows(diff, new Map([[gap.gapId, expansion]]));
    assert.equal(expanded.some((item) => item.kind === "context-control"), false);
    assert.deepEqual(expanded.filter((item) => item.kind === "context").map((item) => item.newLine), Array.from({ length: 10 }, (_, index) => index + 14));
  }
});

test("a large shared gap exposes twenty-line batches and consumes the final remainder", () => {
  const firstHunk = { kind: "hunk", content: "@@ -10 +10 @@", hunkId: "hunk:10:1:10:1" };
  const secondHunk = { kind: "hunk", content: "@@ -70 +70 @@", hunkId: "hunk:70:1:70:1" };
  const gap = {
    gapId: `gap:${firstHunk.hunkId}:${secondHunk.hunkId}`,
    beforeHunkId: firstHunk.hunkId,
    afterHunkId: secondHunk.hunkId,
    lines: contextLines(14, 45),
    startLineCount: 23,
    hasMore: false,
  };
  const diff = { lines: [firstHunk, secondHunk], contextGaps: [gap] };

  const collapsed = diffPresentationRows(diff, new Map());
  assert.deepEqual(collapsed[0].controls.map((item) => item.lineCount), [20, 20]);
  const afterForty = diffPresentationRows(diff, new Map([[gap.gapId, { fromStart: 0, fromEnd: 40 }]]));
  const finalBoundary = afterForty.find((item) => item.kind === "context-control");
  assert.deepEqual(finalBoundary.controls.map((item) => item.lineCount), [5, 5]);
  const complete = diffPresentationRows(diff, new Map([[gap.gapId, { fromStart: 0, fromEnd: 45 }]]));
  assert.equal(complete.some((item) => item.kind === "context-control"), false);
});

test("a partially loaded large gap keeps start and end windows on their authoritative sides", () => {
  const firstHunk = { kind: "hunk", content: "@@ -10 +10 @@", hunkId: "hunk:10:1:10:1" };
  const secondHunk = { kind: "hunk", content: "@@ -120 +120 @@", hunkId: "hunk:120:1:120:1" };
  const gap = {
    gapId: `gap:${firstHunk.hunkId}:${secondHunk.hunkId}`,
    beforeHunkId: firstHunk.hunkId,
    afterHunkId: secondHunk.hunkId,
    lines: [...contextLines(14, 20), ...contextLines(96, 20)],
    startLineCount: 20,
    hasMore: true,
  };
  const rows = diffPresentationRows(
    { lines: [firstHunk, secondHunk], contextGaps: [gap] },
    new Map([[gap.gapId, { fromStart: 20, fromEnd: 40 }]]),
  );
  const boundaryIndex = rows.findIndex((item) => item.kind === "context-control");
  assert.deepEqual(rows.slice(0, boundaryIndex).filter((item) => item.kind === "context").map((item) => item.newLine), Array.from({ length: 20 }, (_, index) => index + 14));
  assert.deepEqual(rows.slice(boundaryIndex + 1).filter((item) => item.kind === "context").map((item) => item.newLine), Array.from({ length: 20 }, (_, index) => index + 96));
});

test("boundaries disappear when a diff has no omitted context", () => {
  const hunk = { kind: "hunk", content: "@@ -1 +1 @@", hunkId: "hunk:1:1:1:1" };
  const diff = {
    lines: [hunk, { kind: "deletion", content: "old", oldLine: 1 }, { kind: "addition", content: "new", newLine: 1 }],
    contextGaps: [],
  };
  assert.deepEqual(diffPresentationRows(diff, new Map()).map((item) => item.kind), ["deletion", "addition"]);
});
