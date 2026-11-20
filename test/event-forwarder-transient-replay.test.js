const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { withAttachmentApp } = require('./fixtures/attachment-route-parity.js');

const eventsModule = require('../packages/controlled-instance/src/web/events.ts');
const OriginalWebEventBus = eventsModule.WebEventBus;
let capturedBus;
eventsModule.WebEventBus = class CapturingWebEventBus extends OriginalWebEventBus {
  constructor(...args) {
    super(...args);
    capturedBus = this;
  }
};

const { NodeAgentInstanceEventForwarder } = require('../packages/node-agent/src/events.ts');
const { ControlPlaneEventBus } = require('../packages/control-plane/src/control-plane/events/bus.ts');
const { ControlPlaneNodeAgentTunnelTransport } = require('../packages/control-plane/src/control-plane/nodes/tunnel.ts');

const INSTANCE_ID = 'inst_transient_replay';
const REPLAY_SINCE = '2026-11-20T00:00:00.000Z';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class ForwarderOutput extends EventEmitter {
  constructor(nodeId, tunnel, frames) {
    super();
    this.OPEN = WebSocket.OPEN;
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.nodeId = nodeId;
    this.tunnel = tunnel;
    this.frames = frames;
  }

  send(value) {
    const message = JSON.parse(String(value));
    this.frames.push(message);
    this.tunnel.handleMessage(this.nodeId, message);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function createForwarder(base) {
  return new NodeAgentInstanceEventForwarder(
    { listInstances: () => [{ id: INSTANCE_ID, ready: true, target: { api: base } }] },
    undefined,
    { safetyIntervalMs: 60_000 },
  );
}

function attachOutput(forwarder, nodeId, tunnel) {
  const frames = [];
  const output = new ForwarderOutput(nodeId, tunnel, frames);
  forwarder.addOutput(output, { expectsTransientSubscription: true });
  assert.equal(forwarder.setOutputSubscription(output, {
    replaySince: REPLAY_SINCE,
    messageDeltas: { allInstances: true, instanceIds: [] },
    timelineAllSessions: false,
    timelineSessions: [],
  }), true);
  forwarder.start();
  return { output, frames };
}

test('U02.2 replayed transient delta crosses forwarder only for the owning node', async () => {
  await withAttachmentApp(async app => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.ok(capturedBus, 'controlled instance WebEventBus must be captured');

    const ownedEvents = [];
    const ownedBus = new ControlPlaneEventBus();
    ownedBus.on(event => ownedEvents.push(event));
    const ownedTunnel = new ControlPlaneNodeAgentTunnelTransport(ownedBus, {
      validateInstanceScope: async (nodeId, instanceId) => nodeId === 'node_owner' && instanceId === INSTANCE_ID,
    });
    const ownedForwarder = createForwarder(base);
    const owned = attachOutput(ownedForwarder, 'node_owner', ownedTunnel);
    capturedBus.publish('ai-session.message-delta', {
      instanceId: INSTANCE_ID,
      sessionId: 'session-replay',
      providerSessionId: 'provider-replay',
      turnId: 'turn-replay',
      itemId: 'item-replay',
      delta: 'replayed-text',
      generatedAt: '2026-11-20T00:00:02.000Z',
    });
    try {
      const replayed = await waitFor(
        () => ownedEvents.find(event => event.type === 'ai-session.message-delta' && event.replay === true),
        'replayed message delta at Control Plane',
      );
      assert.equal(replayed.payload.delta, 'replayed-text');
      assert.equal(replayed.scope.instanceId, INSTANCE_ID);
      assert.equal(replayed.scope.nodeId, 'node_owner');
    } finally {
      ownedForwarder.stop();
      owned.output.close();
    }

    const unownedEvents = [];
    const unownedBus = new ControlPlaneEventBus();
    unownedBus.on(event => unownedEvents.push(event));
    const unownedTunnel = new ControlPlaneNodeAgentTunnelTransport(unownedBus, {
      validateInstanceScope: async () => false,
    });
    const unownedForwarder = createForwarder(base);
    const unowned = attachOutput(unownedForwarder, 'node_unowned', unownedTunnel);
    capturedBus.publish('ai-session.message-delta', {
      instanceId: INSTANCE_ID,
      sessionId: 'session-replay',
      providerSessionId: 'provider-replay',
      turnId: 'turn-replay',
      itemId: 'item-replay',
      delta: 'dropped-text',
      generatedAt: '2026-11-20T00:00:03.000Z',
    });
    try {
      await waitFor(
        () => unowned.frames.some(frame => frame.type === 'node-agent.streams.hello'),
        'unowned forwarder producer hello',
      );
      await sleep(300);
      assert.deepEqual(unownedEvents, []);
    } finally {
      unownedForwarder.stop();
      unowned.output.close();
    }
  });
});
