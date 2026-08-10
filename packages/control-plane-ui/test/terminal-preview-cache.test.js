import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BoundedInactiveLruCache } from "../src/apps/control-plane/terminalPreviewCache.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(testDir, "../src/apps/control-plane/useTerminalPreview.ts"), "utf8");
const pane = fs.readFileSync(path.resolve(testDir, "../src/apps/control-plane/instance-detail/SessionPaneContent.vue"), "utf8");
const preview = fs.readFileSync(path.resolve(testDir, "../src/apps/control-plane/instance-detail/SessionPreview.vue"), "utf8");

test("terminal previews use a bounded inactive LRU cache independent of pane components", () => {
  assert.match(source, /MAX_CACHED_TERMINAL_PREVIEWS = 5/);
  assert.match(source, /BoundedInactiveLruCache<CachedTerminalPreview>\(MAX_CACHED_TERMINAL_PREVIEWS\)/);
  assert.match(source, /detach\(host:[\s\S]*terminalPreviewParkingRoot\(\)\.appendChild\(this\.container\)/);
  assert.doesNotMatch(source.match(/detach\(host:[\s\S]*?\n  }/)?.[0] || "", /socket\?\.close|terminal\?\.dispose/);
  assert.match(pane, /:cache-key="sessionKey"/);
  assert.doesNotMatch(pane, /:key="sessionKey"/);
});

test("inactive terminals keep their renderer DOM connected in a parking root", () => {
  assert.match(source, /document\.body\.appendChild\(element\)/);
  assert.match(source, /terminal\.open\(container\)/);
  assert.match(source, /host\.appendChild\(this\.container\)/);
  assert.doesNotMatch(source.match(/detach\(host:[\s\S]*?\n  }/)?.[0] || "", /terminal\?\.element\?\.remove/);
});

test("a stale asynchronous mount cannot detach the terminal adopted by a newer mount", () => {
  assert.equal((source.match(/if \(generation !== mountGeneration\) return;/g) || []).length, 3);
  assert.doesNotMatch(source, /generation !== mountGeneration \|\|[^\n]*detachTerminalPreview/);
});

test("bounded terminal cache evicts the least recently used inactive entry and pins active panes", () => {
  const disposed = [];
  const entry = (id, lastUsed, active = false) => ({ active, lastUsed, dispose: () => disposed.push(id) });
  const cache = new BoundedInactiveLruCache(5);
  assert.equal(cache.add("active-left", entry("active-left", 1, true)), true);
  assert.equal(cache.add("oldest-inactive", entry("oldest-inactive", 2)), true);
  assert.equal(cache.add("recent-a", entry("recent-a", 3)), true);
  assert.equal(cache.add("active-right", entry("active-right", 4, true)), true);
  assert.equal(cache.add("recent-b", entry("recent-b", 5)), true);

  assert.equal(cache.add("new", entry("new", 6)), true);
  assert.equal(cache.size, 5);
  assert.equal(cache.get("active-left")?.active, true);
  assert.equal(cache.get("active-right")?.active, true);
  assert.equal(cache.get("oldest-inactive"), undefined);
  assert.deepEqual(disposed, ["oldest-inactive"]);
});

test("bounded terminal cache refuses to evict active entries", () => {
  const cache = new BoundedInactiveLruCache(2);
  cache.add("left", { active: true, lastUsed: 1, dispose() {} });
  cache.add("right", { active: true, lastUsed: 2, dispose() {} });
  assert.equal(cache.add("third", { active: true, lastUsed: 3, dispose() {} }), false);
  assert.equal(cache.size, 2);
});

test("authoritative terminal session removal prunes cached terminals", () => {
  assert.match(preview, /pruneTerminalPreviewCache\([\s\S]*session\.kind === "terminal"/);
  assert.match(source, /terminalPreviewCache\.prune\(\(entry\) => entry\.scope !== scope \|\| validKeys\.has\(entry\.key\)\)/);
});

test("terminal cache pruning disposes entries missing from the authoritative session set", () => {
  const disposed = [];
  const cache = new BoundedInactiveLruCache(5);
  cache.add("keep", { active: false, lastUsed: 1, dispose: () => disposed.push("keep") });
  cache.add("remove", { active: false, lastUsed: 2, dispose: () => disposed.push("remove") });
  cache.prune((_entry) => _entry.lastUsed === 1);
  assert.equal(cache.get("keep")?.lastUsed, 1);
  assert.equal(cache.get("remove"), undefined);
  assert.deepEqual(disposed, ["remove"]);
});
