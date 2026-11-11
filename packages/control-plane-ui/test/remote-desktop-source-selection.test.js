import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSelectedSourceIdentity,
  resolveRefreshedSource,
  selectedSourceIdentity,
} from "../src/apps/control-plane/instance-detail/remoteDesktopSourceSelection.ts";

function sourceEntry(overrides = {}) {
  return {
    sourceRef: "ref-a",
    kind: "window",
    title: "TaskHandoff Remote Desktop Test",
    subtitle: "XTerm",
    width: 724,
    height: 472,
    capturable: true,
    reason: null,
    ...overrides,
  };
}

test("selected source visible identity survives persistence sanitization", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  assert.deepEqual(parseSelectedSourceIdentity(selected), selected);
  assert.equal(parseSelectedSourceIdentity({ ...selected, kind: "" }), undefined);
  assert.equal(parseSelectedSourceIdentity({ ...selected, width: -1 }), undefined);
});

test("source reference refresh remaps an unambiguous visible identity", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  const refreshed = sourceEntry({ sourceRef: "ref-rotated" });
  assert.equal(resolveRefreshedSource([refreshed], "ref-a", selected), refreshed);
});

test("source reference refresh keeps an exact live reference", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  const refreshed = sourceEntry({ sourceRef: "ref-rotated" });
  assert.equal(resolveRefreshedSource([refreshed], "ref-rotated", selected), refreshed);
});

test("source reference refresh never guesses between duplicate visible identities", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  const windows = [
    sourceEntry({ sourceRef: "ref-b" }),
    sourceEntry({ sourceRef: "ref-c" }),
  ];
  assert.equal(resolveRefreshedSource(windows, "ref-a", selected), undefined);
});

test("source reference refresh tolerates a changed title when application and geometry identify one source", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  const refreshed = sourceEntry({ sourceRef: "ref-b", title: "New title" });
  const unrelated = sourceEntry({ sourceRef: "ref-c", subtitle: "Chrome", width: 945, height: 1060 });
  assert.equal(resolveRefreshedSource([refreshed, unrelated], "ref-a", selected), refreshed);
});

test("source identity never crosses source kinds", () => {
  const selected = selectedSourceIdentity(sourceEntry());
  const display = sourceEntry({ sourceRef: "display-1", kind: "display" });
  assert.equal(resolveRefreshedSource([display], "ref-a", selected), undefined);
});
