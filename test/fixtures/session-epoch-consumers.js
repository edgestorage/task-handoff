const assert = require('node:assert/strict');
require('./attachment-route-parity.js'); // workspace source loader
const ai = require('../../packages/protocol/src/ai-sessions.ts');
const appProtocol = require('../../packages/protocol/src/app-sessions.ts');
const { ControlPlaneAiSessionAggregator } = require('../../packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts');
const { ControlPlaneAppSessionAggregator } = require('../../packages/control-plane/src/control-plane/sessions/app-session-aggregator.ts');
const { ControlPlaneEventBus } = require('../../packages/control-plane/src/control-plane/events/bus.ts');
const { ControlPlaneNodeAgentTunnelTransport } = require('../../packages/control-plane/src/control-plane/nodes/tunnel.ts');
const { QueryClient, VueQueryPlugin } = require('@tanstack/vue-query');
const { createApp, effectScope } = require('vue');
const { useAiSessionStore } = require('../../packages/control-plane-ui/src/apps/control-plane/useAiSessionStore.ts');
const { useAppSessionStore } = require('../../packages/control-plane-ui/src/apps/control-plane/useAppSessionStore.ts');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const clone = value => structuredClone(value);
const field = topic => topic === 'ai' ? 'aiSessions' : 'appSessions';
const view = (topic, state) => ({ instances: state ? [{ instanceId: 'standalone', streamId: state.streamId,
  revision: state.revision, lastEventAt: state.lastEventAt, [field(topic)]: state.snapshot }] : [] });
const projection = (topic, data) => {
  assert.ok(data.instances.length <= 1);
  const entry = data.instances[0];
  if (!entry) return undefined;
  assert.equal(entry.instanceId, 'standalone');
  return { streamId: entry.streamId, revision: entry.revision, lastEventAt: entry.lastEventAt, snapshot: entry[field(topic)] };
};
const descriptor = (topic, epoch, revision) => ({ topic: `${topic}.sessions`, instanceId: 'standalone',
  streamId: epoch.states[0].streamId, latestRevision: revision, earliestRetainedRevision: 1 });

function uiStore(topic, initial, request) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const queryKey = [`control-plane-${topic}-sessions`, '*'];
  queryClient.setQueryData(queryKey, view(topic, initial));
  const vue = createApp({ render: () => null });
  vue.use(VueQueryPlugin, { queryClient });
  const scope = effectScope();
  const refresh = async (signal, instanceId) => view(topic, await request('snapshot', [instanceId], signal));
  const delta = (instanceId, streamId, revision, signal) => request('delta', [instanceId, streamId, revision], signal);
  const store = scope.run(() => vue.runWithContext(() => topic === 'ai'
    ? useAiSessionStore({ queryKey: () => queryKey, boardInstances: () => [], aiSessions: () => undefined,
      aiSessionsApi: { refresh, delta } })
    : useAppSessionStore({ queryKey: () => queryKey, boardInstances: () => [], appSessions: () => undefined,
      apiLoader: (url, options) => {
        const params = new URL(url, 'http://fixture.invalid/').searchParams;
        assert.equal(url.split('?')[0], 'app-sessions');
        return params.get('refresh') === 'true' ? refresh(options.signal, params.get('instanceId'))
          : delta(params.get('instanceId'), params.get('streamId'), Number(params.get('sinceRevision')), options.signal);
      } })));
  return { apply: event => store.applyEvent(clone(event)), recover: d => store.recoverDescriptor(d),
    messageDelta: payload => { assert.equal(topic, 'ai'); return store.applyMessageDelta(payload); },
    read: () => projection(topic, queryClient.getQueryData(queryKey)),
    close: () => { scope.stop(); queryClient.clear(); } };
}

async function consumer(topic, kind, initial) {
  const requests = [], notifications = new Map(), publicEvents = [];
  const request = (type, args, signal) => {
    const gate = deferred();
    const record = { type, args, signal, resolve: value => gate.resolve(clone(value)) };
    requests.push(record);
    notifications.get(requests.length - 1)?.resolve(record);
    return gate.promise;
  };
  const next = async (index, type, args) => {
    let record = requests[index];
    if (!record) {
      const gate = deferred();
      notifications.set(index, gate);
      record = await gate.promise;
    }
    assert.equal(record.type, type);
    assert.deepEqual(record.args, args);
    return record;
  };
  const ui = uiStore(topic, initial, kind === 'ui' ? request : () => {
    throw new Error('converged public events must not cause UI recovery requests');
  });
  let owner, transport, acceptedGate;
  const bus = new ControlPlaneEventBus();
  bus.connect({ readyState: 1, OPEN: 1, on: () => {}, send: frame => {
    const { type, payload } = JSON.parse(frame);
    const event = { type, payload };
    publicEvents.push(event);
    ui.apply(event);
  } });
  const publish = event => bus.publish(event.type, event.payload, {
    topic: `${topic}.sessions`, scope: { instanceId: 'standalone' },
  });
  if (kind === 'cp') {
    const Aggregator = topic === 'ai' ? ControlPlaneAiSessionAggregator : ControlPlaneAppSessionAggregator;
    owner = new Aggregator({ bootstrap: async () => view(topic, initial),
      recoverSnapshot: instanceId => request('snapshot', [instanceId]),
      recoverDelta: (...args) => request('delta', args), onRecoveredEvent: publish });
    await owner.list();
    transport = new ControlPlaneNodeAgentTunnelTransport(bus, {
      validateInstanceScope: (nodeId, instanceId) => nodeId === 'node_epoch' && instanceId === 'standalone',
      onSessionEvent: event => {
        const accepted = owner.handleEvent(event);
        acceptedGate.resolve(accepted);
        return accepted;
      },
    });
  }
  return {
    requests, next, publicEvents, ui,
    recover: d => owner ? owner.advertiseStream('standalone', d) : ui.recover(d),
    apply: async event => {
      if (!owner) return ui.apply(event);
      // Exercise the real tunnel parser, scope queue, aggregator acceptance
      // gate and public bus serialization. The fake socket only captures wire.
      acceptedGate = deferred();
      transport.handleMessage('node_epoch', { type: 'node-agent.event.forwarded', event: {
        ...clone(event), topic: `${topic}.sessions`, scope: { instanceId: 'standalone' },
      } });
      return acceptedGate.promise;
    },
    read: async () => {
      const state = owner ? projection(topic, await owner.list()) : ui.read();
      assert.deepEqual(ui.read(), state, 'UI consumes the same authoritative projection');
      return clone(state);
    },
    check: async () => {
      if (!owner) return;
      assert.equal(owner.diagnostics().activeRecoveries, 0);
      const state = projection(topic, await owner.list());
      const delta = await owner.delta({ instanceId: 'standalone', streamId: state.streamId, sinceRevision: 0 });
      assert.equal(delta.syncRequired, false);
      assert.equal(delta.latestRevision, state.revision);
      assert.ok(delta.events.length > 0);
      for (const event of delta.events) assert.equal(event.payload.meta.streamId, state.streamId);
      assert.deepEqual(delta.events.map(event => event.payload.meta.revision),
        Array.from({ length: state.revision }, (_, index) => index + 1));
    },
    close: ui.close,
  };
}

function validate(topic, samples) {
  const protocol = topic === 'ai' ? ai : appProtocol;
  const stateSchema = topic === 'ai' ? protocol.AiSessionsStateSchema : protocol.AppSessionsStateSchema;
  const deltaSchema = topic === 'ai' ? protocol.AiSessionDeltaResponseSchema : protocol.AppSessionDeltaResponseSchema;
  const reduce = topic === 'ai' ? protocol.applyAiSessionStreamEvent : protocol.applyAppSessionStreamEvent;
  for (const epoch of Object.values(samples)) {
    epoch.states.forEach((state, index) => {
      stateSchema.parse(state);
      assert.equal(state.revision, index + 1);
      assert.equal(state.lastEventAt, epoch.events[index].payload.meta.generatedAt);
    });
    deltaSchema.parse(epoch.delta);
    assert.deepEqual(epoch.delta.events, epoch.events.slice(1));
    let current;
    for (let index = 0; index < 3; index++) {
      const event = epoch.events[index];
      assert.equal(event.payload.meta.previousRevision, index);
      assert.equal(event.payload.meta.streamId, epoch.states[0].streamId);
      assert.equal(event.payload.meta.instanceId, 'standalone');
      const result = reduce(current, event);
      assert.equal(result.kind, 'applied');
      current = result.projection;
      assert.deepEqual(current, epoch.states[index]);
    }
  }
  assert.notEqual(samples.old.states[0].streamId, samples.next.states[0].streamId);
  // Reducers have no descriptor/epoch authority: cross-stream snapshots are
  // intentionally accepted. Obsolete events must be rejected at CP ingress.
  assert.equal(reduce(samples.next.states[0], samples.old.events[0]).kind, 'applied');
  assert.equal(reduce(samples.next.states[0], samples.old.events[2]).kind, 'snapshot-required');
}

async function runScenario(topic, kind, name, samples) {
  validate(topic, samples);
  const { old, next: fresh } = samples;
  const c = await consumer(topic, kind, name === 'C03' ? undefined : old.states[0]);
  const states = [];
  const check = async expected => {
    const actual = await c.read();
    assert.deepEqual(actual, expected);
    states.push(actual ?? null);
  };
  const recover = (epoch, revision) => c.recover(descriptor(topic, epoch, revision));
  try {
    if (name === 'C01') {
      assert.equal(kind, 'cp', 'late producer events are tested at the public ingress owner');
      const pending = recover(fresh, 1);
      const snapshot = await c.next(0, 'snapshot', ['standalone']);
      const beforeEvents = c.publicEvents.length;
      for (const event of [old.events[0], old.events[2]]) {
        assert.equal(await c.apply(event), false);
        await check(old.states[0]);
      }
      assert.equal(c.publicEvents.length, beforeEvents);
      assert.equal(c.requests.length, 1, 'obsolete events do not change new-stream high-water');
      snapshot.resolve(fresh.states[0]);
      await pending;
      await check(fresh.states[0]);
      const afterEvents = c.publicEvents.length;
      for (const event of [old.events[0], old.events[2]]) {
        assert.equal(await c.apply(event), false);
        await check(fresh.states[0]);
      }
      assert.equal(c.publicEvents.length, afterEvents);
      assert.equal(c.requests.length, 1);
      assert.equal(await c.apply(fresh.events[1]), true);
      await check(fresh.states[1]);
    } else if (name === 'C02') {
      const previous = recover(old, 3);
      const oldDelta = await c.next(0, 'delta', ['standalone', old.states[0].streamId, 1]);
      const current = recover(fresh, 1);
      if (kind === 'cp') oldDelta.resolve(old.delta); // CP serializes/rechecks epoch after await.
      const snapshot = await c.next(1, 'snapshot', ['standalone']);
      await check(old.states[0]);
      snapshot.resolve(fresh.states[0]);
      await current;
      await check(fresh.states[0]);
      if (kind === 'ui') {
        assert.equal(oldDelta.signal.aborted, true);
        oldDelta.resolve(old.delta); // A loader can finish despite AbortSignal.
      }
      await previous;
      await check(fresh.states[0]);
      await c.apply(fresh.events[1]);
      await check(fresh.states[1]);
      assert.equal(c.requests.length, 2);
    } else if (name === 'C03') {
      const previous = recover(old, 3);
      const oldSnapshot = await c.next(0, 'snapshot', ['standalone']);
      const current = recover(fresh, 1);
      if (kind === 'cp') oldSnapshot.resolve(old.states[2]);
      const snapshot = await c.next(1, 'snapshot', ['standalone']);
      await check(undefined);
      snapshot.resolve(fresh.states[0]);
      await current;
      await check(fresh.states[0]);
      if (kind === 'ui') {
        assert.equal(oldSnapshot.signal.aborted, true);
        oldSnapshot.resolve(old.states[2]);
      }
      await previous;
      await check(fresh.states[0]);
      await c.apply(fresh.events[1]);
      await check(fresh.states[1]);
      assert.equal(c.requests.length, 2);
      if (kind === 'cp') assert.ok(c.publicEvents.every(event => event.payload.meta.streamId === fresh.states[0].streamId));
    } else {
      assert.equal(name, 'C04');
      const pending = recover(fresh, 1);
      const snapshot = await c.next(0, 'snapshot', ['standalone']);
      await c.apply(fresh.events[2]); // rev3 arrives before snapshot rev1.
      await check(old.states[0]);
      snapshot.resolve(fresh.states[0]);
      const delta = await c.next(1, 'delta', ['standalone', fresh.states[0].streamId, 1]);
      await check(fresh.states[0]);
      delta.resolve(fresh.delta);
      await pending;
      await check(fresh.states[2]);
      await c.apply(fresh.events[1]); // Late same-stream event must stay stale.
      await check(fresh.states[2]);
      assert.equal(c.requests.length, 2);
    }
    await c.check();
    return { states, requests: c.requests.map(({ type, args }) => ({ type, args })),
      publicEvents: c.publicEvents.map(event => {
        const result = clone(event);
        const meta = result.payload.meta;
        // Only CP's test-run-generated trace IDs are nondeterministic. Producer
        // trace identities, timestamps, fields, ordering and revisions remain.
        if (/^(ais|aps)_(bootstrap|recovery)_/.test(meta.traceId)) {
          meta.traceId = `<cp-${meta.streamId}-${meta.revision}>`;
        }
        return result;
      }) };
  } finally { c.close(); }
}

async function observeConsumers(samples) {
  const output = {};
  for (const topic of Object.keys(samples)) {
    assert.ok(['ai', 'app'].includes(topic));
    output[topic] = {};
    for (const name of ['C01', 'C02', 'C03', 'C04']) {
      output[topic][name] = {};
      for (const kind of name === 'C01' ? ['cp'] : ['cp', 'ui']) {
        output[topic][name][kind] = await runScenario(topic, kind, name, samples[topic]);
      }
    }
  }
  return output;
}

module.exports = { runScenario, observeConsumers, consumer };

if (require.main === module) {
  const timeout = setTimeout(() => { console.error('U02.7 consumers timed out'); process.exit(1); }, 20000);
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const { topic, samples } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const fixture = require('../../controlled-instance-rs/crates/instance/tests/fixtures/session-epoch-parity.json');
    assert.ok(['ai', 'app'].includes(topic));
    assert.deepEqual(samples, fixture.expected[topic]);
    assert.deepEqual(await observeConsumers({ [topic]: samples }), await observeConsumers({ [topic]: fixture.expected[topic] }));
    console.log('U02.7 C01-C04: Rust authority output matches Node through the same CP and UI consumers');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
}
