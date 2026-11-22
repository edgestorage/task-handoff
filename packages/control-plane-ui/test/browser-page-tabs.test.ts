import assert from "node:assert/strict";
import test from "node:test";
import { moveBrowserPageToSlot, type BrowserTabSlot } from "../src/apps/control-plane/instance-detail/browserPageTabs.ts";

function slots(): BrowserTabSlot[] {
  return [
    { key: "tab-a", pageKey: "page-a" },
    { key: "tab-b", pageKey: "page-b" },
  ];
}

test("moving a page re-points the target slot without touching tab identity", () => {
  const current = slots();
  const result = moveBrowserPageToSlot(current, "tab-a", "page-b");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replacedPageKey, "page-a");
  assert.deepEqual(result.sourceSlot, current[1]);
  assert.deepEqual(current, [
    { key: "tab-a", pageKey: "page-b" },
    { key: "tab-b", pageKey: "page-b" },
  ]);
  // The caller replaces the source slot with a fresh blank page, so both
  // slots stay bound to distinct page hosts.
  result.sourceSlot.pageKey = "page-blank";
  assert.deepEqual(current, [
    { key: "tab-a", pageKey: "page-b" },
    { key: "tab-b", pageKey: "page-blank" },
  ]);
  assert.equal(new Set(current.map((slot) => slot.pageKey)).size, current.length);
});

test("moving a page is a no-op for the same slot, unknown keys, or a shared page", () => {
  const current = slots();
  assert.deepEqual(moveBrowserPageToSlot(current, "tab-a", "page-a"), { ok: false });
  assert.deepEqual(moveBrowserPageToSlot(current, "missing", "page-b"), { ok: false });
  assert.deepEqual(moveBrowserPageToSlot(current, "tab-a", "missing"), { ok: false });
  const shared: BrowserTabSlot[] = [
    { key: "tab-a", pageKey: "page-a" },
    { key: "tab-b", pageKey: "page-a" },
  ];
  assert.equal(moveBrowserPageToSlot(shared, "tab-a", "page-a").ok, false);
  assert.deepEqual(current, slots());
});
