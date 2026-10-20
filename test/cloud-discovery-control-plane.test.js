const assert = require("node:assert/strict");
const test = require("node:test");

test("Control Plane connection dialing follows the discovered active origin", async () => {
  const { CloudControlConnectionManager } = await import("../packages/control-plane/src/control-plane/cloud-connectivity/connections.ts");
  const connects = [];
  const marks = [];
  let epoch = 0;
  const manager = new CloudControlConnectionManager({
    state: {
      backgroundCredential: () => "credential",
      snapshot: () => ({
        status: "active",
        scopes: { deviceAccess: true, nodeRelay: false },
        serviceOrigin: "https://primary.example.test",
        cloudControlPlaneId: "cp_cloud_a",
        identity: { controlPlaneId: "control_plane_a" },
      }),
      nextConnectionEpoch: () => ++epoch,
    },
    originResolver: {
      activeOrigin: () => "https://backup.example.test",
      endpoints: () => ["https://primary.example.test", "https://backup.example.test"],
      markSuccess: (origin) => marks.push(`success:${origin}`),
      markFailure: (origin) => marks.push(`failure:${origin}`),
    },
    connector: {
      async connect(input) {
        connects.push(input.serviceOrigin);
        return { async close() {} };
      },
    },
    onEvent: async () => undefined,
  });

  assert.equal((await manager.connectOnce()).status, "connected");
  assert.deepEqual(connects, ["https://backup.example.test"]);
  assert.deepEqual(marks, ["success:https://backup.example.test"]);
});
