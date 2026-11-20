const assert = require('node:assert/strict');
const path = require('node:path');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { AiSessionsStateSchema } = require('../../packages/protocol/src/ai-sessions.ts');
const { ControlPlaneAiSessionAggregator } = require('../../packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts');

const START = Date.parse('2026-11-05T00:00:00.000Z');
const RETENTION = 3600000;

async function observeNodeAiClock(timers) {
  let sessionId;
  const { WebEventBus } = require('../../packages/controlled-instance/src/web/events.ts');
  const originalPublish = WebEventBus.prototype.publish;
  let observedStartup;
  const startupPublished = new Promise(resolve => { observedStartup = resolve; });
  WebEventBus.prototype.publish = function(type, payload, ...args) {
    const result = originalPublish.call(this, type, payload, ...args);
    if (type === 'ai-session.snapshot' && payload.meta.revision === 1) observedStartup(payload);
    return result;
  };
  timers.enable({ apis: ['Date'], now: START });
  try {
    return await withAttachmentApp(async app => {
      await app.ready();
      const request = async (url, payload) => {
        const response = await app.inject({ method: payload === undefined ? 'GET' : url.endsWith('/story') ? 'PUT' : 'POST', url, payload });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().data;
      };
      const state = () => request('/api/ai-sessions/state');
      const read = () => request(`/api/ai-sessions/${sessionId}/read`, {});
      const story = storyId => request(`/api/ai-sessions/${sessionId}/story`, { storyId });
      const startup = await state();
      const streamId = startup.streamId;
      assert.equal(startup.revision, 0, 'initial state must precede the first authority publish');
      const delta = revision => request(`/api/ai-sessions?streamId=${encodeURIComponent(streamId)}&sinceRevision=${revision}`);
      timers.setTime(START + 1000);
      // Observe completion of the production deferred startup publish. This is
      // an event barrier, not a sleep or a guessed race with the read handler.
      let deadline;
      try {
        const published = await Promise.race([startupPublished, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('missing startup authority publish')), 3000);
        })]);
        assert.equal(published.meta.reason, 'startup');
        assert.equal(published.meta.generatedAt, new Date(START + 1000).toISOString());
      } finally { clearTimeout(deadline); }
      await read();
      const first = await state();
      timers.setTime(START + 2000);
      await story('story-clock');
      const retained = await state();
      const originalEvents = (await delta(0)).events;
      timers.setTime(START + 2000 + RETENTION);
      const boundaryDelta = await delta(1);
      const boundary = await state();
      timers.setTime(START + 2001 + RETENTION);
      const idleBeforeDelta = await state();
      const expiredDelta = await delta(1);
      const expired = await state();
      const expiredAlias = await request('/api/ai-sessions');
      await read(); // Already read; no semantic summary change or event.
      const noop = await state();
      timers.setTime(START + 3000 + RETENTION);
      await story('story-after-expiry');
      const resumed = await state();
      const resumedDelta = await delta(2);
      const traces = new Map();
      // No timestamp or revision normalization. Session/stream/trace identities
      // are unpredictable; verify their ownership before mapping them bijectively.
      function normalize(value, key = '') {
        if (key === 'streamId') { assert.equal(value, streamId); return '<stream>'; }
        if (key === 'id') { assert.equal(value, sessionId); return '<session>'; }
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === 'object') {
          const output = {};
          for (const [name, item] of Object.entries(value)) {
            if (name === 'traceId') {
              assert.match(item, /^ais_evt_/);
              if (traces.has(value.revision)) assert.equal(item, traces.get(value.revision));
              else { assert.ok(![...traces.values()].includes(item)); traces.set(value.revision, item); }
              output[name] = `<trace-${value.revision}>`;
            } else output[name] = normalize(item, name);
          }
          return output;
        }
        return value;
      }
      return normalize({ startup, first, retained, originalEvents, boundaryDelta, boundary,
        idleBeforeDelta, expiredDelta, expired, expiredAlias, noop, resumed, resumedDelta });
    }, root => {
      const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
      const registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
      sessionId = registry.start({ agent: 'codex', creationSource: 'ai-session', providerSessionId: 'provider-clock',
        title: 'Clock session', status: 'idle', phase: 'unknown' }, { timestamp: new Date(START).toISOString() }).id;
      return { aiSessionRegistry: registry };
    });
  } finally { WebEventBus.prototype.publish = originalPublish; timers.reset(); }
}

async function observeAiClockConsumer(samples) {
  for (const name of ['first', 'retained', 'expired', 'resumed']) AiSessionsStateSchema.parse(samples[name]);
  const view = state => ({ instances: [{ instanceId: 'standalone', streamId: state.streamId,
    revision: state.revision, lastEventAt: state.lastEventAt, aiSessions: state.snapshot }] });
  const read = async consumer => (await consumer.list()).instances[0];
  const events = [];
  const cold = new ControlPlaneAiSessionAggregator({ bootstrap: async () => view(samples.expired),
    onRecoveredEvent: event => events.push(event) });
  const coldExpired = await read(cold);
  assert.equal(coldExpired.lastEventAt, samples.expired.lastEventAt);
  assert.equal(events[0].payload.meta.generatedAt, samples.expired.lastEventAt);
  let bootstrap = samples.retained;
  const warmEvents = [];
  const warm = new ControlPlaneAiSessionAggregator({ bootstrap: async () => view(bootstrap),
    onRecoveredEvent: event => warmEvents.push(event) });
  const warmBefore = await read(warm);
  bootstrap = samples.expired;
  await warm.list({ refresh: true });
  const warmExpired = await read(warm);
  assert.deepEqual(warmExpired, warmBefore, 'same-revision refresh must retain the accepted projection');
  assert.equal(warmEvents.length, 1, 'timestamp fallback cannot publish another revision');
  const next = samples.resumedDelta.events[0];
  for (const consumer of [cold, warm]) {
    assert.equal(consumer.handleEvent(next), true);
    const entry = await read(consumer);
    assert.equal(entry.revision, 3);
    assert.equal(entry.lastEventAt, samples.resumed.lastEventAt);
    assert.deepEqual(entry.aiSessions.sessions, samples.resumed.snapshot.sessions);
  }
  return { coldExpired, warmBefore, warmExpired, coldResumed: await read(cold), warmResumed: await read(warm) };
}

module.exports = { observeNodeAiClock, observeAiClockConsumer };

if (require.main === module) {
  const timeout = setTimeout(() => { console.error('U02.6 consumer comparison timed out'); process.exit(1); }, 20000);
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const actual = await observeAiClockConsumer(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const expected = require('../../controlled-instance-rs/crates/instance/tests/fixtures/ai-session-clock-parity.json').consumer;
    assert.deepEqual(actual, expected);
    console.log('U02.6 C03 exact consumer state and timestamps match Node output');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
}
