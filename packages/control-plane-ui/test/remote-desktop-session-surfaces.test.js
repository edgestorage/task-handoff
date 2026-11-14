import assert from "node:assert/strict";
import test from "node:test";
import { nextTick } from "vue";
import { createSessionRemoteDesktopSurfaces, desktopSessionSurfaceKey } from "../src/apps/control-plane/instance-detail/sessionRemoteDesktopSurfaces.ts";

const scope = { instanceId: "instance-a", sessionId: "session-a" };
const surface = (patch = {}) => ({ ...scope, element: {}, active: true, preview: true, ...patch });

test("preview and detail share a single connection owner and detail takes the interactive destination", async () => {
  const registry = createSessionRemoteDesktopSurfaces();
  const preview = Symbol(), detail = Symbol();
  const p = surface(), d = surface({ preview: false });
  registry.update(preview, p);
  const key = registry.groups.value[0].key;
  registry.update(detail, d);
  assert.equal(registry.groups.value.length, 1);
  assert.equal(registry.groups.value[0].key, key);
  assert.equal(registry.groups.value[0].primary, d);
  assert.equal(registry.groups.value[0].preview, false);
  registry.release(preview);
  await nextTick();
  assert.equal(registry.groups.value[0].primary, d);
  assert.equal(registry.groups.value[0].active, true);
});

test("closing detail yields to a read-only preview, last inactive consumer pauses, last release disposes", async () => {
  const registry = createSessionRemoteDesktopSurfaces();
  const p = Symbol(), d = Symbol();
  registry.update(p, surface());
  registry.update(d, surface({ preview: false }));
  registry.release(d);
  await nextTick();
  assert.equal(registry.groups.value[0].preview, true);
  registry.update(p, surface({ active: false }));
  assert.equal(registry.groups.value[0].active, false);
  assert.equal(registry.groups.value[0].primary, undefined);
  registry.release(p);
  await nextTick();
  assert.equal(registry.groups.value.length, 0);
});

test("moving between a card and tab within a render keeps the same session owner", async () => {
  const registry = createSessionRemoteDesktopSurfaces();
  const p = Symbol(), d = Symbol();
  registry.update(p, surface());
  const key = registry.groups.value[0].key;
  registry.release(p);
  assert.equal(registry.groups.value.length, 1);
  registry.update(d, surface({ preview: false }));
  await nextTick();
  assert.equal(registry.groups.value.length, 1);
  assert.equal(registry.groups.value[0].key, key);
});

test("only visible mirrors receive already decoded pictures and size notifications are per consumer", () => {
  const registry = createSessionRemoteDesktopSurfaces();
  const calls = [];
  const preview = surface({ frame: f => calls.push(["preview", f]), streamSize: s => calls.push(["size", s]) });
  registry.update(Symbol(), preview);
  registry.update(Symbol(), surface({ preview: false, frame: () => calls.push(["detail"]) }));
  registry.update(Symbol(), surface({ active: false, frame: () => calls.push(["hidden"]) }));
  const key = registry.groups.value[0].key;
  const frame = { source: {}, width: 1920, height: 1080 };
  registry.frame(key, frame);
  registry.frame(key, frame);
  assert.deepEqual(calls.map(c => c[0]), ["size", "preview", "preview"]);
  registry.update(Symbol(), surface({ streamSize: () => calls.push(["new-size"]) }));
  registry.frame(key, frame);
  assert.equal(calls.at(-1)[0], "new-size");
});

test("instance and AI Session scopes isolate capture targets and explicit removal", async () => {
  const registry = createSessionRemoteDesktopSurfaces();
  const received = [];
  registry.update(Symbol(), surface({ selectionChange: t => received.push(t) }));
  registry.update(Symbol(), surface({ sessionId: "session-b", selectionChange: () => assert.fail("other session") }));
  registry.update(Symbol(), surface({ instanceId: "instance-b", selectionChange: () => assert.fail("other instance") }));
  const target = { kind: "window", sourceRef: "window-a", title: "Editor", subtitle: null, width: 800, height: 600 };
  registry.selection(desktopSessionSurfaceKey("instance-a", "session-a"), target);
  assert.deepEqual(received, [target]);
  assert.equal(registry.groups.value.find(g => g.sessionId === "session-a" && g.instanceId === "instance-a").target, target);
  registry.forget("instance-a", "session-a");
  assert.equal(registry.groups.value.length, 2);
  registry.frame(desktopSessionSurfaceKey("instance-a", "session-a"), { source: {}, width: 1, height: 1 });
  await nextTick();
  assert.equal(registry.groups.value.length, 2);
});

test("reusing a surface for another AI Session releases its prior owner", async () => {
  const registry = createSessionRemoteDesktopSurfaces(), id = Symbol();
  registry.update(id, surface());
  registry.update(id, surface({ sessionId: "session-b" }));
  await nextTick();
  assert.equal(registry.groups.value.length, 1);
  assert.equal(registry.groups.value[0].sessionId, "session-b");
});
