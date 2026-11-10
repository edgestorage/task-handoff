import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSelectedWindowInfo,
  resolveRefreshedWindow,
  selectedWindowInfo,
} from "../src/apps/control-plane/instance-detail/remoteDesktopWindowSelection.ts";

function windowEntry(overrides = {}) {
  return {
    windowRef: "ref-a",
    title: "TaskHandoff Remote Desktop Test",
    applicationName: "XTerm",
    width: 724,
    height: 472,
    capturable: true,
    reason: null,
    ...overrides,
  };
}

test("selected window display identity survives persistence sanitization", () => {
  const selected = selectedWindowInfo(windowEntry());
  assert.deepEqual(parseSelectedWindowInfo(selected), selected);
  assert.equal(parseSelectedWindowInfo({ ...selected, windowRef: "" }), undefined);
  assert.equal(parseSelectedWindowInfo({ ...selected, width: -1 }), undefined);
});

test("window reference refresh remaps an unambiguous visible identity", () => {
  const selected = selectedWindowInfo(windowEntry());
  const refreshed = windowEntry({ windowRef: "ref-rotated" });
  assert.equal(resolveRefreshedWindow([refreshed], "ref-a", selected), refreshed);
});

test("window reference refresh keeps an exact live reference", () => {
  const selected = selectedWindowInfo(windowEntry());
  const refreshed = windowEntry({ windowRef: "ref-rotated" });
  assert.equal(resolveRefreshedWindow([refreshed], "ref-rotated", selected), refreshed);
});

test("window reference refresh never guesses between duplicate visible identities", () => {
  const selected = selectedWindowInfo(windowEntry());
  const windows = [
    windowEntry({ windowRef: "ref-b" }),
    windowEntry({ windowRef: "ref-c" }),
  ];
  assert.equal(resolveRefreshedWindow(windows, "ref-a", selected), undefined);
});

test("window reference refresh tolerates a changed title when application and geometry identify one window", () => {
  const selected = selectedWindowInfo(windowEntry());
  const refreshed = windowEntry({ windowRef: "ref-b", title: "New title" });
  const unrelated = windowEntry({ windowRef: "ref-c", applicationName: "Chrome", width: 945, height: 1060 });
  assert.equal(resolveRefreshedWindow([refreshed, unrelated], "ref-a", selected), refreshed);
});
