import assert from "node:assert/strict";
import test from "node:test";
import { computed, effectScope, nextTick, ref } from "vue";

const aiSessionEventDemand = await import("../src/apps/control-plane/useAiSessionEventDemand.ts");
const {
  aiSessionMessageDeltaDemand,
  aiSessionTimelineDemand,
  useAiSessionMessageDeltaDemand,
  useAiSessionTimelineDemand,
} = aiSessionEventDemand;

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
  assert.equal("aiSessionTransientReplaySince" in aiSessionEventDemand, false);

  const stableMessageDemand = aiSessionMessageDeltaDemand.value;
  const stableTimelineDemand = aiSessionTimelineDemand.value;
  firstInstanceIds.value = ["instance-a"];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, stableMessageDemand);
  assert.equal(aiSessionTimelineDemand.value, stableTimelineDemand);

  firstInstanceIds.value = [];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, stableMessageDemand);

  second.stop();
  assert.deepEqual(aiSessionMessageDeltaDemand.value, { allInstances: false, instanceIds: [] });
  assert.deepEqual(aiSessionTimelineDemand.value, [{ instanceId: "instance-a", sessionId: "session-a" }]);
  first.stop();
  assert.deepEqual(aiSessionTimelineDemand.value, []);
});

test("AI session message demand updates only when its semantic scope changes", async () => {
  const instances = ref([{ id: "instance-a", heartbeatAgeMs: 1 }]);
  const scope = effectScope();
  scope.run(() => {
    useAiSessionMessageDeltaDemand(computed(() => ({ instanceIds: instances.value.map((instance) => instance.id) })));
  });

  const initialDemand = aiSessionMessageDeltaDemand.value;
  instances.value = [{ id: "instance-a", heartbeatAgeMs: 2 }];
  await nextTick();
  assert.equal(aiSessionMessageDeltaDemand.value, initialDemand);

  instances.value = [
    { id: "instance-a", heartbeatAgeMs: 3 },
    { id: "instance-b", heartbeatAgeMs: 1 },
  ];
  await nextTick();
  assert.deepEqual(aiSessionMessageDeltaDemand.value.instanceIds, ["instance-a", "instance-b"]);

  instances.value = [{ id: "instance-a", heartbeatAgeMs: 4 }];
  await nextTick();
  assert.deepEqual(aiSessionMessageDeltaDemand.value.instanceIds, ["instance-a"]);
  scope.stop();
});

test("switching sessions only changes the live timeline subscription", async () => {
  const target = ref({ instanceId: "instance-switch", sessionId: "session-a" });
  const scope = effectScope();
  scope.run(() => {
    useAiSessionTimelineDemand(computed(() => target.value));
  });

  assert.deepEqual(aiSessionTimelineDemand.value, [{ instanceId: "instance-switch", sessionId: "session-a" }]);

  target.value = { instanceId: "instance-switch", sessionId: "session-b" };
  await nextTick();
  assert.deepEqual(aiSessionTimelineDemand.value, [{ instanceId: "instance-switch", sessionId: "session-b" }]);

  target.value = { instanceId: "instance-switch", sessionId: "session-a" };
  await nextTick();
  assert.deepEqual(aiSessionTimelineDemand.value, [{ instanceId: "instance-switch", sessionId: "session-a" }]);
  scope.stop();
});
