import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import { useInstanceSettingsDirectory } from "../src/apps/control-plane/settings/useInstanceSettingsDirectory.ts";

function instance(id, overrides = {}) {
  return {
    id, name: id, nodeId: "node_a", status: "running", connectionStatus: "online",
    runtime: { type: "docker", name: "Docker host" }, workspace: {},
    ...overrides,
  };
}

function directory(items, nodeItems = []) {
  const instances = ref(items);
  const nodes = ref(nodeItems);
  return { instances, nodes, ...useInstanceSettingsDirectory(instances, nodes) };
}

test("the directory includes stopped and offline instances without changing input order", () => {
  const items = Object.freeze([
    Object.freeze(instance("inst_z", { status: "stopped", connectionStatus: "offline" })),
    Object.freeze(instance("inst_a", { nodeId: "node_b" })),
  ]);
  const state = directory(items);
  assert.deepEqual(state.filteredInstances.value, items);
  assert.equal(state.instances.value, items);
  assert.deepEqual(state.statusOptions.value, ["running", "stopped"]);
  assert.equal(state.hasActiveFilters.value, false);
});

test("search and node, lifecycle and runtime filters intersect and can be cleared together", () => {
  const state = directory([
    instance("inst_1", { image: { name: "Codex environment" } }),
    instance("inst_2", { image: { name: "Codex environment" }, status: "stopped" }),
    instance("inst_3", { nodeId: "node_b", image: { name: "Codex environment" } }),
    instance("inst_4", { runtime: { type: "local", name: "Host" } }),
  ]);
  state.search.value = "  CODEX  ";
  state.nodeId.value = "node_a";
  state.status.value = "running";
  state.runtimeType.value = "docker";
  assert.deepEqual(state.filteredInstances.value.map((item) => item.id), ["inst_1"]);
  assert.equal(state.hasActiveFilters.value, true);
  // Available choices come from the complete directory, independently of filters.
  assert.deepEqual(state.statusOptions.value, ["running", "stopped"]);
  assert.deepEqual(state.runtimeOptions.value, ["docker", "local"]);
  state.clearFilters();
  assert.equal(state.filteredInstances.value.length, 4);
  assert.equal(state.hasActiveFilters.value, false);
});

test("authoritative instance and node replacements update results without resetting filters", () => {
  const state = directory([instance("inst_1", { node: { name: "Old node name" } })], [{ id: "node_a", name: "New node name" }]);
  state.search.value = "New node";
  state.status.value = "running";
  assert.equal(state.filteredInstances.value.length, 1);
  assert.equal(state.nodeName(state.instances.value[0]), "New node name");
  state.instances.value = [instance("inst_1", { status: "stopped" })];
  assert.equal(state.filteredInstances.value.length, 0);
  state.instances.value = [instance("inst_2")];
  assert.deepEqual(state.filteredInstances.value.map((item) => item.id), ["inst_2"]);
  state.nodes.value = [{ id: "node_a", name: "Renamed node" }];
  assert.equal(state.filteredInstances.value.length, 0);
  assert.equal(state.nodeOptions.value[0].name, "Renamed node");
  assert.equal(state.search.value, "New node");
});

test("opaque IDs and records awaiting optional metadata remain searchable", () => {
  const state = directory([instance("legacy:Mixed/ID", { runtime: undefined, node: undefined, image: undefined })]);
  state.search.value = "mixed/id";
  assert.equal(state.filteredInstances.value.length, 1);
  assert.deepEqual(state.runtimeOptions.value, []);
  assert.deepEqual(state.nodeOptions.value, [{ id: "node_a", name: "node_a" }]);
  state.search.value = "missing";
  assert.equal(state.filteredInstances.value.length, 0);
  state.instances.value = [];
  state.clearFilters();
  assert.deepEqual(state.filteredInstances.value, []);
  assert.deepEqual(state.nodeOptions.value, []);
});
