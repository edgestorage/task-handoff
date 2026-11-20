const assert = require('node:assert/strict');
// Reuse the isolated source server and workspace TS loader. No Rust-side
// consumer implementation or production Node fallback is introduced.
const { observeNodeAppAuthority } = require('./app-session-authority-parity.js');
const {
  AppSessionsStateSchema, AppSessionDeltaResponseSchema, AppSessionEventType,
  AppSessionSnapshotEventSchema, AppSessionPatchEventSchema, applyAppSessionStreamEvent,
} = require('../../packages/protocol/src/app-sessions.ts');
const { ControlPlaneAppSessionAggregator } = require('../../packages/control-plane/src/control-plane/sessions/app-session-aggregator.ts');
const { QueryClient, VueQueryPlugin } = require('@tanstack/vue-query');
const { createApp, effectScope } = require('vue');
const { useAppSessionStore } = require('../../packages/control-plane-ui/src/apps/control-plane/useAppSessionStore.ts');

function verifySamples(samples) {
  for (const name of ['initial', 'recovered', 'final']) AppSessionsStateSchema.parse(samples[name]);
  AppSessionDeltaResponseSchema.parse(samples.recoveryDelta);
  assert.equal(samples.events.length, 4);
  const streamId = samples.initial.streamId;
  const traces = new Set();
  samples.events.forEach((event, index) => {
    (index === 0 ? AppSessionSnapshotEventSchema : AppSessionPatchEventSchema).parse(event.payload);
    assert.equal(event.type, index === 0 ? AppSessionEventType.Snapshot : AppSessionEventType.Patch);
    assert.equal(event.payload.meta.revision, index + 1);
    if (index) assert.equal(event.payload.meta.previousRevision, index);
    assert.equal(event.payload.meta.streamId, streamId);
    assert.equal(event.payload.meta.instanceId, 'standalone');
    assert.match(event.payload.meta.traceId, /^aps_evt_/);
    assert.ok(!traces.has(event.payload.meta.traceId));
    traces.add(event.payload.meta.traceId);
  });
  for (const [name, revision] of [['initial', 1], ['recovered', 3], ['final', 4]]) {
    const state = samples[name];
    assert.equal(state.streamId, streamId);
    assert.equal(state.revision, revision);
    assert.equal(state.lastEventAt, samples.events[revision - 1].payload.meta.generatedAt);
  }
  assert.deepEqual(samples.recoveryDelta, {
    streamId, instanceId: 'standalone', sinceRevision: 1, latestRevision: 3,
    earliestRetainedRevision: 3, syncRequired: true, events: [],
  });
}

function descriptor(samples, revision) {
  return { topic: 'app.sessions', instanceId: 'standalone', streamId: samples.initial.streamId,
    latestRevision: revision, earliestRetainedRevision: 3 };
}

function view(state) {
  return { updatedAt: state.snapshot.updatedAt, instances: [{ instanceId: 'standalone',
    streamId: state.streamId, revision: state.revision, lastEventAt: state.lastEventAt, appSessions: state.snapshot }] };
}

function projection(result) {
  assert.equal(result.instances.length, 1);
  const entry = result.instances[0];
  assert.equal(entry.instanceId, 'standalone');
  return { streamId: entry.streamId, revision: entry.revision, lastEventAt: entry.lastEventAt, snapshot: entry.appSessions };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function adapter(kind, samples) {
  const calls = [];
  const gate = deferred();
  const loadDelta = async (instanceId, streamId, sinceRevision) => {
    assert.equal(instanceId, 'standalone');
    assert.equal(streamId, samples.initial.streamId);
    assert.equal(sinceRevision, 1);
    calls.push(['delta', instanceId, streamId, sinceRevision]);
    await gate.promise;
    return structuredClone(samples.recoveryDelta);
  };
  const loadSnapshot = async instanceId => {
    assert.equal(instanceId, 'standalone');
    calls.push(['snapshot', instanceId]);
    return structuredClone(samples.recovered);
  };
  if (kind === 'aggregator') {
    const recoveredEvents = [];
    const consumer = new ControlPlaneAppSessionAggregator({
      bootstrap: async () => view(samples.initial), recoverDelta: loadDelta, recoverSnapshot: loadSnapshot,
      onRecoveredEvent: event => recoveredEvents.push(event),
    });
    await consumer.list();
    await consumer.advertiseStream('standalone', descriptor(samples, 1));
    assert.deepEqual(calls, []);
    return {
      calls, gate, apply: event => consumer.handleEvent(event),
      read: async () => projection(await consumer.list()),
      recover: () => consumer.advertiseStream('standalone', descriptor(samples, 3)),
      checkRecovery: () => {
        assert.equal(recoveredEvents.length, 2); // HTTP bootstrap + recovery snapshot.
        assert.equal(recoveredEvents[1].type, AppSessionEventType.Snapshot);
        assert.equal(recoveredEvents[1].payload.meta.revision, 3);
        assert.equal(consumer.diagnostics().activeRecoveries, 0);
        assert.equal(consumer.diagnostics().snapshotRecoveries, 1);
      },
      close: () => {},
    };
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const queryKey = ['control-plane-app-sessions', '*'];
  queryClient.setQueryData(queryKey, view(samples.initial));
  const app = createApp({ render: () => null });
  app.use(VueQueryPlugin, { queryClient });
  const scope = effectScope();
  const consumer = scope.run(() => app.runWithContext(() => useAppSessionStore({
    queryKey: () => queryKey, boardInstances: () => [], appSessions: () => undefined,
    apiLoader: async url => {
      const parsed = new URL(url, 'http://fixture.invalid/');
      assert.equal(parsed.pathname, '/app-sessions');
      const params = parsed.searchParams;
      assert.equal(params.get('instanceId'), 'standalone');
      if (params.get('refresh') === 'true') {
        assert.equal(url, 'app-sessions?refresh=true&instanceId=standalone');
        return view(await loadSnapshot('standalone'));
      }
      assert.equal(url, `app-sessions?instanceId=standalone&streamId=${encodeURIComponent(samples.initial.streamId)}&sinceRevision=1`);
      return loadDelta(params.get('instanceId'), params.get('streamId'), Number(params.get('sinceRevision')));
    },
  })));
  return {
    calls, gate, apply: event => consumer.applyEvent(event),
    read: async () => projection(queryClient.getQueryData(queryKey)),
    recover: () => consumer.recoverDescriptor(descriptor(samples, 3)),
    checkRecovery: () => {},
    close: () => { scope.stop(); queryClient.clear(); },
  };
}

async function consume(samples) {
  verifySamples(samples);
  const [snapshot1, patch2, patch3, patch4] = samples.events;
  // HTTP snapshot.updatedAt is the read time; a patch-derived projection uses
  // meta.generatedAt. Compare every field with that existing boundary rule.
  const finalProjection = { ...samples.final, snapshot: { ...samples.final.snapshot, updatedAt: patch4.payload.meta.generatedAt } };
  const apply = applyAppSessionStreamEvent;
  let current = samples.initial;
  const reduced = [];
  const step = (event, expectedKind) => {
    const before = current;
    const result = apply(current, event);
    assert.equal(result.kind, expectedKind);
    if (expectedKind === 'applied') current = result.projection;
    else assert.strictEqual(result.projection, before, 'rejected event preserves the authoritative projection');
    reduced.push(result);
  };
  step(snapshot1, 'duplicate');
  step(patch2, 'applied');
  step(patch2, 'duplicate');
  step(patch3, 'applied');
  step(patch2, 'stale');
  step(snapshot1, 'stale');
  current = samples.initial;
  step(patch3, 'gap');
  assert.equal(reduced.at(-1).expectedRevision, 2);
  assert.equal(reduced.at(-1).receivedRevision, 3);
  // Fault injection at the consumer boundary: a cached snapshot from another
  // stream must not accept this producer's patch, even with a plausible revision.
  const obsolete = { ...samples.initial, streamId: 'obsolete-stream' };
  const wrongStream = apply(obsolete, patch2);
  assert.equal(wrongStream.kind, 'snapshot-required');
  assert.strictEqual(wrongStream.projection, obsolete);
  assert.equal(wrongStream.streamId, samples.initial.streamId);
  const missingSnapshot = apply(undefined, patch2);
  assert.equal(missingSnapshot.kind, 'snapshot-required');
  assert.equal(missingSnapshot.projection, undefined);
  current = samples.recovered; // HTTP snapshot replaces the missing history.
  step(patch4, 'applied');
  assert.deepEqual(current, finalProjection);

  const observations = { reducer: { steps: reduced, wrongStream, missingSnapshot } };
  for (const kind of ['aggregator', 'ui']) {
    const consumer = await adapter(kind, samples);
    try {
      const states = [];
      for (const [event, revision] of [[snapshot1, 1], [patch2, 2], [patch2, 2], [patch3, 3], [patch2, 3], [snapshot1, 3]]) {
        consumer.apply(event);
        const state = await consumer.read();
        assert.equal(state.revision, revision);
        states.push(state);
      }
      assert.deepEqual(states[1], states[2]);
      assert.deepEqual(states[3], states[4]);
      assert.deepEqual(states[3], states[5]);
      assert.deepEqual(consumer.calls, [], 'duplicates/stale events never fetch recovery data');
      observations[kind] = { ordered: states };
    } finally { consumer.close(); }

    const recovery = await adapter(kind, samples);
    try {
      recovery.apply(patch3); // Drop revision 2; do not synthesize producer events.
      const pending = recovery.recover(); // Join the existing recovery; no sleep/poll.
      const before = await recovery.read();
      assert.deepEqual(before, samples.initial);
      assert.deepEqual(recovery.calls, [['delta', 'standalone', samples.initial.streamId, 1]]);
      recovery.gate.resolve();
      await pending;
      const restored = await recovery.read();
      assert.deepEqual(restored, samples.recovered);
      recovery.apply(patch4);
      const final = await recovery.read();
      assert.deepEqual(final, finalProjection);
      assert.deepEqual(recovery.calls, [['delta', 'standalone', samples.initial.streamId, 1], ['snapshot', 'standalone']]);
      recovery.checkRecovery();
      observations[kind].recovery = { before, restored, final, calls: recovery.calls };
    } finally { recovery.gate.resolve(); recovery.close(); }
  }
  return observations;
}

// Compare full payloads/projections. Validate original timestamps first; map
// nondeterministic wall clocks to a valid ISO value, preserving record-created
// times. Stream and trace maps preserve identity/revision relationships checked
// above. Revisions, previousRevision, counts, paths and ordering stay untouched.
function normalize(value, streamId, key = '') {
  if (key === 'streamId') {
    assert.ok(value === streamId || value === 'obsolete-stream');
    return value === streamId ? '<stream>' : value;
  }
  if (['generatedAt', 'lastEventAt', 'updatedAt'].includes(key) && value !== '2026-11-02T00:00:00.000Z') {
    assert.ok(Number.isFinite(Date.parse(value)));
    return '2026-11-05T00:00:00.000Z';
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, streamId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, name === 'traceId'
      ? `<trace-${value.revision}>` : normalize(item, streamId, name)]));
  }
  // Network call tuples contain the stream as an opaque string.
  return value === streamId ? '<stream>' : value;
}

async function compareConsumers(rustSamples) {
  const nodeSamples = await observeNodeAppAuthority({ consumerSamples: true });
  const node = { samples: nodeSamples, consumers: await consume(nodeSamples) };
  if (rustSamples) {
    const rust = { samples: rustSamples, consumers: await consume(rustSamples) };
    assert.deepEqual(normalize(rust, rustSamples.initial.streamId), normalize(node, nodeSamples.initial.streamId));
  }
  return normalize(node, nodeSamples.initial.streamId);
}

module.exports = { compareConsumers };

if (require.main === module) {
  // This test-only process is also bounded when invoked by cargo test.
  const timeout = setTimeout(() => { console.error('U02.4 consumer comparison timed out'); process.exit(1); }, 20000);
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await compareConsumers(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    console.log('U02.4 C01-C04: Node HTTP and Rust authority outputs match through reducer, aggregator and UI recovery');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
}
