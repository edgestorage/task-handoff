const test = require("node:test");
const assert = require("node:assert/strict");
const { ImagePullTerminalEventType, InstanceLifecycleEventType } = require("../packages/protocol/src/control-plane.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { ImagePullProgressProjector } = require("../packages/control-plane/src/control-plane/images/image-pull-progress.ts");
const { ControlPlaneNodeAgentTunnelTransport } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");

function output(sequence, data, extra = {}) {
  return {
    instanceId: "inst_pull_progress",
    generation: 2,
    requestedReference: "docker.io/example/app:v1",
    sequence,
    observedAt: new Date().toISOString(),
    data,
    ...extra,
  };
}

test("control-plane derives a concise layer and byte summary from the authoritative Docker TTY", () => {
  const events = new ControlPlaneEventBus();
  const projector = new ImagePullProgressProjector(events);
  const progress = [];
  events.on((event) => {
    projector.handle(event);
    if (event.type === ImagePullTerminalEventType.Progress) progress.push(event.payload);
  });

  events.publish(ImagePullTerminalEventType.Output, output(1000, [
    "latest: Pulling from example/app\r\n",
    "aaaaaa111111: Downloading  5 MiB/10 MiB\r\n",
    "bbbbbb222222: Extracting  2 MiB/5 MiB\r\n",
  ].join("")), { scope: { instanceId: "inst_pull_progress" } });
  events.publish(ImagePullTerminalEventType.Output, output(2000, "\u001b[1A\u001b[2K\rbbbbbb222222: Pull complete\r\naaaaaa111111: Pull complete\r\n"), { scope: { instanceId: "inst_pull_progress" } });
  events.publish(ImagePullTerminalEventType.Finished, {
    instanceId: "inst_pull_progress",
    generation: 2,
    requestedReference: "docker.io/example/app:v1",
    sequence: 3000,
    observedAt: new Date().toISOString(),
    outcome: "succeeded",
  }, { scope: { instanceId: "inst_pull_progress" } });

  assert.equal(progress.length, 1);
  assert.equal(progress[0].status, "complete");
  assert.deepEqual(progress[0].layers, { total: 2, completed: 2, downloaded: 0, downloading: 0, extracting: 0 });
  assert.equal(progress[0].percent, 100);
  assert.match(progress[0].message, /complete/i);
  const [snapshot] = projector.snapshots();
  assert.match(snapshot.terminalTail, /Pull complete/);
  projector.close();
});

test("TTY replay replaces the buffered terminal instead of duplicating it", () => {
  const events = new ControlPlaneEventBus();
  const projector = new ImagePullProgressProjector(events);
  events.on((event) => projector.handle(event));
  events.publish(ImagePullTerminalEventType.Output, output(1000, "old output\r\n"));
  events.publish(ImagePullTerminalEventType.Output, output(2000, "current output\r\n", { replay: true }));
  const [snapshot] = projector.snapshots();
  assert.doesNotMatch(snapshot.terminalTail, /old output/);
  assert.match(snapshot.terminalTail, /current output/);
  projector.close();
});

test("a newer lifecycle generation removes retained pull diagnostics", () => {
  const events = new ControlPlaneEventBus();
  const projector = new ImagePullProgressProjector(events);
  events.on((event) => projector.handle(event));
  events.publish(ImagePullTerminalEventType.Output, output(1000, "failed output\r\n"));
  events.publish(InstanceLifecycleEventType.Snapshot, {
    instanceId: "inst_pull_progress",
    revision: 2,
    updatedAt: new Date().toISOString(),
    status: "provisioning",
    health: "unknown",
    connectionStatus: "unknown",
    accessStatus: "endpoint-unreachable",
    imageProvisioning: {
      phase: "checking-image",
      requestedReference: "docker.io/example/app:v1",
      generation: 3,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    workspace: { status: "pending" },
    runtime: { labels: {} },
  });
  assert.deepEqual(projector.snapshots(), []);
  projector.close();
});

test("reverse tunnel preserves image pull event order behind one scope validation", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  let validations = 0;
  let releaseValidation;
  const validation = new Promise((resolve) => { releaseValidation = resolve; });
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => {
      validations += 1;
      return validation;
    },
  });
  const forward = (type, payload) => tunnel.handleMessage("node_pull", {
    type: "node-agent.event.forwarded",
    event: { type, topic: "instances", payload, scope: { instanceId: payload.instanceId } },
  });
  forward(ImagePullTerminalEventType.Output, output(1000, "first\r\n"));
  forward(ImagePullTerminalEventType.Output, output(2000, "second\r\n"));
  forward(ImagePullTerminalEventType.Finished, {
    instanceId: "inst_pull_progress",
    generation: 2,
    requestedReference: "docker.io/example/app:v1",
    sequence: 3000,
    observedAt: new Date().toISOString(),
    outcome: "succeeded",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validations, 1);
  releaseValidation(true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(published.map((event) => event.payload.sequence), [1000, 2000, 3000]);
  assert.equal(validations, 1);
});
