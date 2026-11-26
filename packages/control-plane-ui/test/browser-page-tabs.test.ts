import assert from "node:assert/strict";
import test from "node:test";
import { ensureBrowserPageSlot, type BrowserTabSlot } from "../src/apps/control-plane/instance-detail/browserPageTabs.ts";

function slots(): BrowserTabSlot[] {
  return [
    { key: "tab-a", pageKey: "page-a" },
    { key: "tab-b", pageKey: "page-b" },
  ];
}

test("opening a page that already has a tab selects that slot without creating another host", () => {
  const current = slots();
  const result = ensureBrowserPageSlot(current, "page-b", "tab-new");
  assert.deepEqual(result, { slot: current[1], created: false });
  assert.deepEqual(current, slots());
});

test("opening a page without a tab appends a new slot bound to the existing page host", () => {
  const current = slots();
  const result = ensureBrowserPageSlot(current, "page-external", "tab-new");
  assert.equal(result?.created, true);
  assert.deepEqual(result?.slot, { key: "tab-new", pageKey: "page-external" });
  assert.deepEqual(current, [
    ...slots(),
    { key: "tab-new", pageKey: "page-external" },
  ]);
  // The newly opened page gets its own tab while the current page stays bound
  // to its original slot.
  assert.equal(current[0]?.pageKey, "page-a");
});

test("invalid or duplicate slot identities are ignored", () => {
  const current = slots();
  assert.equal(ensureBrowserPageSlot(current, "", "tab-new"), undefined);
  assert.equal(ensureBrowserPageSlot(current, "page-c", ""), undefined);
  assert.equal(ensureBrowserPageSlot(current, "page-c", "tab-a"), undefined);
  assert.deepEqual(current, slots());
});
