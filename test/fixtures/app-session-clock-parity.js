const assert = require('node:assert/strict');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { AppSessionsStateSchema } = require('../../packages/protocol/src/app-sessions.ts');
const { ControlPlaneAppSessionAggregator } = require('../../packages/control-plane/src/control-plane/sessions/app-session-aggregator.ts');

const START = Date.parse('2026-11-05T00:00:00.000Z');
const RETENTION = 3600000;

async function observeNodeAppClock(timers) {
  let runtime;
  let records = [];
  timers.enable({ apis: ['Date'], now: START });
  try {
    return await withAttachmentApp(async app => {
      await app.ready();
      const get = async url => {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().data;
      };
      const state = () => get('/api/apps/sessions/state');
      const publish = title => {
        records = [{ id: 'app_clock', appId: 'terminal-tty', title, kind: 'tty', status: 'running',
          createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
          workspace: { cwd: '/workspace' }, paths: { sessionDir: '/tmp/session', logDir: '/tmp/logs' } }];
        runtime.emit(title === 'Initial title' ? 'created' : 'updated', records[0]);
      };
      const startup = await state();
      const streamId = startup.streamId;
      const delta = revision => get(`/api/apps/sessions?streamId=${encodeURIComponent(streamId)}&sinceRevision=${revision}`);
      timers.setTime(START + 1000);
      publish('Initial title');
      const first = await state();
      timers.setTime(START + 2000);
      publish('Renamed');
      const retained = await state();
      const originalEvents = (await delta(0)).events;
      timers.setTime(START + 2000 + RETENTION);
      const boundaryDelta = await delta(1);
      const boundary = await state();
      timers.setTime(START + 2001 + RETENTION);
      const idleBeforeDelta = await state(); // State itself does not prune.
      const expiredDelta = await delta(1);
      const expired = await state();
      const expiredAlias = await get('/api/apps/sessions');
      publish('Renamed'); // No semantic change; no event, revision or timestamp.
      const noop = await state();
      timers.setTime(START + 3000 + RETENTION);
      publish('After expiry');
      const resumed = await state();
      const resumedDelta = await delta(2);
      const observation = { startup, first, retained, originalEvents, boundaryDelta, boundary,
        idleBeforeDelta, expiredDelta, expired, expiredAlias, noop, resumed, resumedDelta };
      // Only unpredictable identities are mapped. Every absolute timestamp,
      // revision, previousRevision, full record and array order is compared.
      const traces = new Map();
      function normalize(value, key = '') {
        if (key === 'streamId') { assert.equal(value, streamId); return '<stream>'; }
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === 'object') {
          const output = {};
          for (const [name, item] of Object.entries(value)) {
            if (name === 'traceId') {
              assert.match(item, /^aps_evt_/);
              if (traces.has(value.revision)) assert.equal(item, traces.get(value.revision));
              else { assert.ok(![...traces.values()].includes(item)); traces.set(value.revision, item); }
              output[name] = `<trace-${value.revision}>`;
            } else output[name] = normalize(item, name);
          }
          return output;
        }
        return value;
      }
      return normalize(observation);
    }, () => {
      const { AppRuntimeManager } = require('../../packages/app-runtime/src/runtime.ts');
      const { resolveStoragePaths } = require('../../packages/core/src/storage/paths.ts');
      runtime = new AppRuntimeManager(resolveStoragePaths());
      runtime.listSessions = () => records;
      return { appRuntime: runtime };
    });
  } finally { timers.reset(); }
}

async function observeClockConsumer(samples) {
  for (const name of ['first', 'retained', 'expired', 'resumed']) AppSessionsStateSchema.parse(samples[name]);
  const view = state => ({ instances: [{ instanceId: 'standalone', streamId: state.streamId,
    revision: state.revision, lastEventAt: state.lastEventAt, appSessions: state.snapshot }] });
  const read = async consumer => (await consumer.list()).instances[0];
  const events = [];
  const cold = new ControlPlaneAppSessionAggregator({ bootstrap: async () => view(samples.expired),
    onRecoveredEvent: event => events.push(event) });
  const coldExpired = await read(cold);
  assert.equal(coldExpired.lastEventAt, samples.expired.lastEventAt);
  assert.equal(events[0].payload.meta.generatedAt, samples.expired.lastEventAt);
  let bootstrap = samples.retained;
  const warmEvents = [];
  const warm = new ControlPlaneAppSessionAggregator({ bootstrap: async () => view(bootstrap),
    onRecoveredEvent: event => warmEvents.push(event) });
  const warmBefore = await read(warm);
  bootstrap = samples.expired;
  await warm.list({ refresh: true });
  const warmExpired = await read(warm);
  assert.deepEqual(warmExpired, warmBefore, 'same-revision refresh cannot replace an accepted projection');
  assert.equal(warmEvents.length, 1, 'timestamp fallback alone cannot emit a new revision');
  const next = samples.resumedDelta.events[0];
  for (const consumer of [cold, warm]) {
    assert.equal(consumer.handleEvent(next), true);
    const entry = await read(consumer);
    assert.equal(entry.revision, 3);
    assert.equal(entry.lastEventAt, samples.resumed.lastEventAt);
    assert.deepEqual(entry.appSessions.sessions, samples.resumed.snapshot.sessions);
  }
  return { coldExpired, warmBefore, warmExpired, coldResumed: await read(cold), warmResumed: await read(warm) };
}

module.exports = { observeNodeAppClock, observeClockConsumer };

if (require.main === module) {
  const timeout = setTimeout(() => { console.error('U02.5 consumer comparison timed out'); process.exit(1); }, 20000);
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const actual = await observeClockConsumer(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const expected = require('../../controlled-instance-rs/crates/instance/tests/fixtures/app-session-clock-parity.json').consumer;
    // Compare lastEventAt and every business field exactly. The independently
    // asserted HTTP read/published snapshot.updatedAt distinction is not part
    // of this timestamp contract (see the Rust owner test).
    const withoutSnapshotReadClock = entries => Object.fromEntries(Object.entries(entries).map(([name, entry]) => {
      const { updatedAt, ...snapshot } = entry.appSessions;
      return [name, { ...entry, appSessions: snapshot }];
    }));
    assert.deepEqual(withoutSnapshotReadClock(actual), withoutSnapshotReadClock(expected));
    console.log('U02.5 C03 exact consumer timestamps match Node output');
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
}
