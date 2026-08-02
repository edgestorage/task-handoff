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
    ready: false,
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

test("reverse tunnel invalidation isolates in-flight validation and queued events", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  let validations = 0;
  let releaseFirst;
  let owned = true;
  const firstValidation = new Promise((resolve) => { releaseFirst = resolve; });
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => {
      validations += 1;
      return validations === 1 ? firstValidation : owned;
    },
  });
  const forward = (sequence) => tunnel.handleMessage("node_pull", {
    type: "node-agent.event.forwarded",
    event: {
      type: ImagePullTerminalEventType.Output,
      topic: "instances",
      payload: output(sequence, `${sequence}\r\n`),
      scope: { instanceId: "inst_pull_progress" },
    },
  });

  forward(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 0,
    validatingScopes: 1,
    queuedScopes: 1,
    scopeEpochs: 1,
  });
  owned = false;
  tunnel.invalidateInstanceScope({ nodeId: "node_pull" });
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 0,
    validatingScopes: 0,
    queuedScopes: 0,
    scopeEpochs: 0,
  });
  forward(2000);
  releaseFirst(true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.equal(validations, 2);
  assert.deepEqual(published, []);
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 0,
    validatingScopes: 0,
    queuedScopes: 0,
    scopeEpochs: 0,
  });
});

test("reverse tunnel validates and orders stream hello with instance events", async () => {
  const events = new ControlPlaneEventBus();
  const observed = [];
  events.on((event) => observed.push(`event:${event.payload.sequence}`));
  let releaseValidation;
  const validation = new Promise((resolve) => { releaseValidation = resolve; });
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: () => validation,
    onStreamsHello: async (instanceId) => {
      observed.push(`hello:${instanceId}`);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });

  tunnel.handleMessage("node_pull", {
    type: "node-agent.streams.hello",
    instanceId: "inst_pull_progress",
    payload: { protocolVersion: 1, streams: [] },
  });
  tunnel.handleMessage("node_pull", {
    type: "node-agent.event.forwarded",
    event: {
      type: ImagePullTerminalEventType.Output,
      topic: "instances",
      payload: output(4000, "ordered\r\n"),
      scope: { instanceId: "inst_pull_progress" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, []);

  releaseValidation(true);
  await new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));
  assert.deepEqual(observed, ["hello:inst_pull_progress", "event:4000"]);
});

test("reverse tunnel invalidation drops an unvalidated stream hello", async () => {
  let releaseValidation;
  const validation = new Promise((resolve) => { releaseValidation = resolve; });
  const hellos = [];
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(undefined, {
    validateInstanceScope: () => validation,
    onStreamsHello: (instanceId) => { hellos.push(instanceId); },
  });

  tunnel.handleMessage("node_unowned", {
    type: "node-agent.streams.hello",
    instanceId: "inst_owned_elsewhere",
    payload: { protocolVersion: 1, streams: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  tunnel.invalidateInstanceScope({ nodeId: "node_unowned", instanceId: "inst_owned_elsewhere" });
  releaseValidation(true);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.deepEqual(hellos, []);
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 0,
    validatingScopes: 0,
    queuedScopes: 0,
    scopeEpochs: 0,
  });
});

test("reverse tunnel rejects a stream hello for an instance the node does not own", async () => {
  const hellos = [];
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(undefined, {
    validateInstanceScope: async () => false,
    onStreamsHello: (instanceId) => { hellos.push(instanceId); },
  });
  tunnel.handleMessage("node_unowned", {
    type: "node-agent.streams.hello",
    instanceId: "inst_owned_elsewhere",
    payload: { protocolVersion: 1, streams: [] },
  });
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(hellos, []);
});

test("a rejected stream hello callback does not poison later instance events", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => true,
    onStreamsHello: async () => { throw new Error("aggregator unavailable"); },
  });

  tunnel.handleMessage("node_pull", {
    type: "node-agent.streams.hello",
    instanceId: "inst_pull_progress",
    payload: { protocolVersion: 1, streams: [] },
  });
  tunnel.handleMessage("node_pull", {
    type: "node-agent.event.forwarded",
    event: {
      type: ImagePullTerminalEventType.Output,
      topic: "instances",
      payload: output(5000, "after rejected hello\r\n"),
      scope: { instanceId: "inst_pull_progress" },
    },
  });
  await new Promise((resolve) => setImmediate(() => setImmediate(() => setImmediate(resolve))));

  assert.deepEqual(published.map((event) => event.payload.sequence), [5000]);
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 1,
    validatingScopes: 0,
    queuedScopes: 0,
    scopeEpochs: 0,
  });
});

test("unknown forwarded instance events share hello ownership and ordering", async (t) => {
  await t.test("owned custom event stays behind hello", async () => {
    const events = new ControlPlaneEventBus();
    const observed = [];
    events.on((event) => observed.push(`event:${event.type}`));
    let releaseValidation;
    const validation = new Promise((resolve) => { releaseValidation = resolve; });
    const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
      validateInstanceScope: () => validation,
      onStreamsHello: (instanceId) => { observed.push(`hello:${instanceId}`); },
    });
    tunnel.handleMessage("node_custom", {
      type: "node-agent.streams.hello",
      instanceId: "inst_custom",
      payload: { protocolVersion: 1, streams: [] },
    });
    tunnel.handleMessage("node_custom", {
      type: "node-agent.event.forwarded",
      event: {
        type: "custom.instance.changed",
        topic: "instances",
        payload: { value: 1 },
        scope: { instanceId: "inst_custom" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, []);
    releaseValidation(true);
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    assert.deepEqual(observed, ["hello:inst_custom", "event:custom.instance.changed"]);
  });

  await t.test("unowned custom event is rejected", async () => {
    const events = new ControlPlaneEventBus();
    const published = [];
    events.on((event) => published.push(event));
    const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
      validateInstanceScope: async () => false,
    });
    tunnel.handleMessage("node_custom", {
      type: "node-agent.event.forwarded",
      event: {
        type: "custom.instance.changed",
        payload: { value: 1 },
        scope: { instanceId: "inst_owned_elsewhere" },
      },
    });
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    assert.deepEqual(published, []);
  });
});
