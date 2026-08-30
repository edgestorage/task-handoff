import assert from "node:assert/strict";
import test from "node:test";
import { computed, effectScope, nextTick, ref } from "vue";

const {
  aiSessionMessageDeltaDemand,
  aiSessionTimelineDemand,
  aiSessionTransientReplaySince,
  useAiSessionMessageDeltaDemand,
  useAiSessionTimelineDemand,
} = await import("../src/apps/control-plane/useAiSessionEventDemand.ts");

test("AI session transient demand is the union of live consumers and is released with their scopes", async () => {
  const firstInstanceIds = ref(["instance-a"]);
  const first = effectScope();
  first.run(() => {
    useAiSessionMessageDeltaDemand(computed(() => ({ instanceIds: firstInstanceIds.value })));
    useAiSessionTimelineDemand(computed(() => ({ instanceId: "instance-a", sessionId: "session-a" })));
  });
  const second = effectScope();
  second.run(() => {
    useAiSessionMessageDeltaDemand({ instanceIds: ["instance-b", "instance-a"] });
    useAiSessionTimelineDemand({ instanceId: "instance-b", sessionId: "session-b" });
  });

  assert.deepEqual(new Set(aiSessionMessageDeltaDemand.value.instanceIds), new Set(["instance-a", "instance-b"]));
  assert.deepEqual(aiSessionTimelineDemand.value, [
    { instanceId: "instance-a", sessionId: "session-a" },
    { instanceId: "instance-b", sessionId: "session-b" },
  ]);
  assert.match(aiSessionTransientReplaySince.value, /^\d{4}-\d{2}-\d{2}T/);

  const stableMessageDemand = aiSessionMessageDeltaDemand.value;
  const stableTimelineDemand = aiSessionTimelineDemand.value;
  const stableReplaySince = aiSessionTransientReplaySince.value;
  firstInstanceIds.value = ["instance-a"];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, stableMessageDemand);
  assert.equal(aiSessionTimelineDemand.value, stableTimelineDemand);
  assert.equal(aiSessionTransientReplaySince.value, stableReplaySince);

  firstInstanceIds.value = [];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, stableMessageDemand);

  second.stop();
  assert.deepEqual(aiSessionMessageDeltaDemand.value, { allInstances: false, instanceIds: [] });
  assert.deepEqual(aiSessionTimelineDemand.value, [{ instanceId: "instance-a", sessionId: "session-a" }]);
  assert.equal(aiSessionTransientReplaySince.value, undefined);
  first.stop();
  assert.deepEqual(aiSessionTimelineDemand.value, []);
  assert.equal(aiSessionTransientReplaySince.value, undefined);
});

test("AI session transient demand publishes a replay barrier only for semantic expansion", async () => {
  const instances = ref([{ id: "instance-a", heartbeatAgeMs: 1 }]);
  const scope = effectScope();
  scope.run(() => {
    useAiSessionMessageDeltaDemand(computed(() => ({ instanceIds: instances.value.map((instance) => instance.id) })));
  });

  const initialDemand = aiSessionMessageDeltaDemand.value;
  const initialReplaySince = aiSessionTransientReplaySince.value;
  instances.value = [{ id: "instance-a", heartbeatAgeMs: 2 }];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, initialDemand);
  assert.equal(aiSessionTransientReplaySince.value, initialReplaySince);

  instances.value = [
    { id: "instance-a", heartbeatAgeMs: 3 },
    { id: "instance-b", heartbeatAgeMs: 1 },
  ];
  await nextTick();
  assert.deepEqual(aiSessionMessageDeltaDemand.value.instanceIds, ["instance-a", "instance-b"]);
  assert.match(aiSessionTransientReplaySince.value, /^\d{4}-\d{2}-\d{2}T/);

  instances.value = [{ id: "instance-a", heartbeatAgeMs: 4 }];
  await nextTick();
  assert.deepEqual(aiSessionMessageDeltaDemand.value.instanceIds, ["instance-a"]);
  assert.equal(aiSessionTransientReplaySince.value, undefined);
  scope.stop();
});
