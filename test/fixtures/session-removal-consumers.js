const assert = require('node:assert/strict');
const { consumer } = require('./session-epoch-consumers.js');
const ai = require('../../packages/protocol/src/ai-sessions.ts');
const app = require('../../packages/protocol/src/app-sessions.ts');
const { useStreamingMessagesStore } = require('../../packages/control-plane-ui/src/apps/control-plane/useStreamingMessagesStore.ts');

const RETENTION = 3600000;
const descriptor = (topic, sample) => ({ topic: `${topic}.sessions`, instanceId: 'standalone',
  streamId: sample.initial.streamId, latestRevision: 3, earliestRetainedRevision: 3 });

function validate(topic, sample) {
  const protocol = topic === 'ai' ? ai : app;
  const reduce = topic === 'ai' ? protocol.applyAiSessionStreamEvent : protocol.applyAppSessionStreamEvent;
  const deltaSchema = topic === 'ai' ? protocol.AiSessionDeltaResponseSchema : protocol.AppSessionDeltaResponseSchema;
  const stateSchema = topic === 'ai' ? protocol.AiSessionsStateSchema : protocol.AppSessionsStateSchema;
  let state;
  for (const [index, name] of ['initial', 'updated', 'removed'].entries()) {
    stateSchema.parse(sample[name]);
    const event = sample.events[index];
    assert.equal(event.payload.meta.revision, index + 1);
    assert.equal(event.payload.meta.previousRevision, index);
    assert.equal(event.payload.meta.streamId, sample.initial.streamId);
    assert.equal(event.payload.meta.instanceId, 'standalone');
    const result = reduce(state, event);
    assert.equal(result.kind, 'applied');
    state = result.projection;
    assert.deepEqual(state, sample[name]);
  }
  const removal = sample.events[2];
  assert.deepEqual(sample.removed.snapshot.sessions.map(session => session.id), [`${topic}_survivor`]);
  assert.deepEqual(sample.noop, sample.removed);
  assert.equal(reduce(state, removal).kind, 'duplicate');
  assert.equal(reduce(state, sample.events[1]).kind, 'stale');
  assert.equal(reduce(state, sample.events[0]).kind, 'stale');
  if (topic === 'ai') {
    assert.equal(removal.type, ai.AiSessionEventType.Patch);
    assert.deepEqual(removal.payload.removed, ['ai_target']);
    assert.deepEqual(removal.payload.upserted, []);
  } else {
    app.AppSessionRemovedEventSchema.parse(removal.payload);
    assert.equal(removal.type, app.AppSessionEventType.Removed);
    assert.equal(removal.payload.sessionId, 'app_target');
    assert.deepEqual(removal.payload.tombstone, sample.updated.snapshot.sessions[0]);
    assert.equal(Date.parse(removal.payload.expiresAt) - Date.parse(removal.payload.meta.generatedAt), RETENTION);
  }
  for (const name of ['delta', 'boundaryDelta', 'expiredDelta']) deltaSchema.parse(sample[name]);
  assert.deepEqual(sample.delta.events, sample.events.slice(1));
  assert.deepEqual(sample.boundaryDelta.events, [removal]);
  assert.equal(sample.boundaryDelta.earliestRetainedRevision, 3);
  assert.equal(sample.boundaryDelta.syncRequired, false);
  assert.deepEqual(sample.expiredDelta.events, []);
  assert.equal(sample.expiredDelta.latestRevision, 3);
  assert.equal(sample.expiredDelta.earliestRetainedRevision, 4);
  assert.equal(sample.expiredDelta.syncRequired, true);
}

// Compatibility for v0.0.47: independently deployed consumers still accept
// this published Removed wire model. Current producers use patch.removed;
// this payload is explicitly a protocol input, not a captured producer event.
function legacyAiRemoval(sample) {
  return { type: ai.AiSessionEventType.Removed, payload: {
    meta: { ...sample.events[2].payload.meta, traceId: 'compat-v0.0.47-ai-removed' },
    sessionIds: ['ai_target'], expiresAt: '2026-11-05T01:00:02.000Z',
  } };
}

async function runRemovalScenario(topic, kind, name, sample) {
  validate(topic, sample);
  const streaming = useStreamingMessagesStore();
  streaming.clear();
  const c = await consumer(topic, kind, sample.initial);
  const states = [], messages = [];
  const target = { instanceId: 'standalone', sessionId: 'ai_target', turnId: 'turn-target', itemId: 'item-target' };
  const survivor = { instanceId: 'standalone', sessionId: 'ai_survivor', turnId: 'turn-survivor', itemId: 'item-survivor' };
  let oldTargetActive, survivorActive;
  if (topic === 'ai') {
    for (const identity of [target, survivor]) {
      assert.equal(c.ui.messageDelta({ ...identity, delta: `${identity.sessionId}-text`, generatedAt: '2026-11-05T00:00:00.000Z' }), true);
    }
    oldTargetActive = streaming.activeMessage('standalone', 'ai_target');
    survivorActive = streaming.activeMessage('standalone', 'ai_survivor');
    assert.equal(streaming.size(), 2);
  }
  const check = async (expected, deleted = false, snapshotRecovery = false) => {
    const actual = await c.read();
    assert.deepEqual(actual, expected);
    states.push(actual);
    if (topic === 'ai') {
      assert.equal(streaming.size(), deleted ? 1 : 2);
      assert.equal(oldTargetActive.value === undefined, deleted);
      assert.equal(streaming.message(target) === undefined, deleted);
      assert.strictEqual(streaming.activeMessage('standalone', 'ai_survivor'), survivorActive);
      assert.equal(survivorActive.value.value.receivedText, 'ai_survivor-text');
      assert.equal(survivorActive.value.value.status, snapshotRecovery ? 'complete' : 'streaming');
      messages.push({ target: oldTargetActive.value?.value ?? null, survivor: survivorActive.value.value });
    }
  };
  try {
    await c.apply(sample.events[1]);
    await check(sample.updated);
    if (name === 'C01' || name === 'C02' || name === 'C05') {
      const event = name === 'C05' ? legacyAiRemoval(sample) : sample.events[2];
      if (name === 'C05') {
        assert.equal(topic, 'ai');
        ai.AiSessionRemovedEventSchema.parse(event.payload);
      }
      await c.apply(event);
      await check(sample.removed, true);
      if (name !== 'C01') {
        const publicCount = c.publicEvents.length;
        for (const late of [event, sample.events[1], sample.events[0]]) {
          await c.apply(late);
          await check(sample.removed, true);
        }
        assert.equal(c.publicEvents.length, publicCount, 'duplicate/stale removals never publish another transition');
      }
      assert.equal(c.requests.length, 0);
      await c.check();
    } else {
      assert.ok(['C03', 'C04'].includes(name));
      const pending = c.recover(descriptor(topic, sample));
      const delta = await c.next(0, 'delta', ['standalone', sample.initial.streamId, 2]);
      await check(sample.updated);
      delta.resolve(name === 'C03' ? sample.boundaryDelta : sample.expiredDelta);
      if (name === 'C04') {
        const snapshot = await c.next(1, 'snapshot', ['standalone']);
        await check(sample.updated);
        snapshot.resolve(sample.removed); // Captured authoritative HTTP response at revision3.
      }
      await pending;
      await check(sample.removed, true, name === 'C04');
      assert.equal(c.requests.length, name === 'C03' ? 1 : 2);
      if (name === 'C03') await c.check();
    }
    // A newly bootstrapped consumer starts from the post-removal authority.
    const cold = await consumer(topic, kind, sample.removed);
    try { assert.deepEqual(await cold.read(), sample.removed); assert.equal(cold.requests.length, 0); }
    finally { cold.close(); }
    return { states, messages, calls: c.requests.map(({ type, args }) => ({ type, args })),
      events: c.publicEvents.map(event => {
        const normalized = structuredClone(event);
        if (/^(ais|aps)_(bootstrap|recovery)_/.test(normalized.payload.meta.traceId)) {
          normalized.payload.meta.traceId = `<cp-${normalized.payload.meta.streamId}-${normalized.payload.meta.revision}>`;
        }
        return normalized;
      }) };
  } finally { c.close(); streaming.clear(); }
}

async function observeRemovalConsumers(topic, sample) {
  const output = {};
  for (const name of topic === 'ai' ? ['C01', 'C02', 'C03', 'C04', 'C05'] : ['C01', 'C02', 'C03', 'C04']) {
    output[name] = {};
    for (const kind of ['cp', 'ui']) output[name][kind] = await runRemovalScenario(topic, kind, name, sample);
  }
  return output;
}

module.exports = { runRemovalScenario, observeRemovalConsumers, legacyAiRemoval };

if (require.main === module) {
  const timeout = setTimeout(() => { console.error('U02.8 consumers timed out'); process.exit(1); }, 20000);
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const { topic, sample } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const golden = require('../../controlled-instance-rs/crates/instance/tests/fixtures/session-removal-parity.json').expected.samples[topic];
    assert.deepEqual(sample, golden);
    assert.deepEqual(await observeRemovalConsumers(topic, sample), await observeRemovalConsumers(topic, golden));
    console.log(`U02.8 ${topic}: Rust producer output matches Node through existing CP/UI deletion and recovery consumers`);
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
}
