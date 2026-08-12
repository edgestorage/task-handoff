import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, ref } from "vue";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
global.window = { localStorage: storage };

const {
  ACTIVE_INSTANCE_STORAGE_KEY,
  useWorkbenchInstances,
} = await import("../src/apps/control-plane/instance-list/useWorkbenchInstances.ts");

function instance(id, createdAt, overrides = {}) {
  return {
    id,
    name: id,
    nodeId: "node-1",
    connectionStatus: "online",
    status: "running",
    createdAt,
    ...overrides,
  };
}

test("sorts instances by node name by default", () => {
  storage.values.clear();
  const instances = ref([
    instance("instance-z", "2026-07-25T12:00:00.000Z", { name: "Zulu", nodeId: "node-a", node: { name: "Alpha" } }),
    instance("instance-b", "2026-07-25T11:00:00.000Z", { name: "Beta", nodeId: "node-b", node: { name: "Bravo" } }),
    instance("instance-a", "2026-07-25T10:00:00.000Z", { name: "Alpha", nodeId: "node-b", node: { name: "Bravo" } }),
  ]);
  const scope = effectScope();
  const state = scope.run(() => useWorkbenchInstances({ instances }));

  assert.equal(state.instanceSortMode.value, "node-asc");
  assert.deepEqual(state.sortedInstances.value.map((item) => item.id), ["instance-z", "instance-a", "instance-b"]);
  scope.stop();
});

test("restores the selected instance after the instance snapshot loads", async () => {
  storage.values.clear();
  storage.setItem(ACTIVE_INSTANCE_STORAGE_KEY, "instance-b");
  const instances = ref([]);
  const scope = effectScope();
  const state = scope.run(() => useWorkbenchInstances({ instances }));

  assert.equal(state.activeInstanceId.value, "instance-b");
  instances.value = [
    instance("instance-a", "2026-07-25T10:00:00.000Z"),
    instance("instance-b", "2026-07-25T09:00:00.000Z"),
  ];
  await nextTick();

  assert.equal(state.activeInstanceId.value, "instance-b");
  assert.equal(state.activeInstance.value.id, "instance-b");
  scope.stop();
});

test("persists explicit selection and replaces a missing stored instance", async () => {
  storage.values.clear();
  storage.setItem(ACTIVE_INSTANCE_STORAGE_KEY, "missing-instance");
  const instances = ref([
    instance("instance-a", "2026-07-25T10:00:00.000Z"),
    instance("instance-b", "2026-07-25T09:00:00.000Z"),
  ]);
  const scope = effectScope();
  const state = scope.run(() => useWorkbenchInstances({ instances }));

  assert.equal(state.activeInstanceId.value, "instance-a");
  assert.equal(storage.getItem(ACTIVE_INSTANCE_STORAGE_KEY), "instance-a");

  state.selectInstance("instance-b");
  assert.equal(storage.getItem(ACTIVE_INSTANCE_STORAGE_KEY), "instance-b");

  instances.value = [instance("instance-a", "2026-07-25T10:00:00.000Z")];
  await nextTick();
  assert.equal(state.activeInstanceId.value, "instance-a");
  assert.equal(storage.getItem(ACTIVE_INSTANCE_STORAGE_KEY), "instance-a");
  scope.stop();
});

test("standalone selection neither falls back nor touches persistent selection", async () => {
  storage.values.clear();
  storage.setItem(ACTIVE_INSTANCE_STORAGE_KEY, "instance-a");
  const activeInstanceId = ref("missing-instance");
  const instances = ref([
    instance("instance-a", "2026-07-25T10:00:00.000Z"),
    instance("instance-b", "2026-07-25T09:00:00.000Z"),
  ]);
  const scope = effectScope();
  const state = scope.run(() => useWorkbenchInstances({
    instances,
    selection: { mode: "standalone", activeInstanceId },
  }));

  assert.equal(state.activeInstance.value, undefined);
  state.selectInstance("instance-b");
  await nextTick();
  assert.equal(state.activeInstance.value.id, "instance-b");
  assert.equal(storage.getItem(ACTIVE_INSTANCE_STORAGE_KEY), "instance-a");

  instances.value = [instance("instance-a", "2026-07-25T10:00:00.000Z")];
  await nextTick();
  assert.equal(activeInstanceId.value, "instance-b");
  assert.equal(state.activeInstance.value, undefined);
  assert.equal(storage.getItem(ACTIVE_INSTANCE_STORAGE_KEY), "instance-a");
  scope.stop();
});
