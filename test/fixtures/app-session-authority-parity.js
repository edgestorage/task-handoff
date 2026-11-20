const assert = require('node:assert/strict');
const { withAttachmentApp } = require('./attachment-route-parity.js');

const RETENTION_MS = 60 * 60 * 1000;
const CREATED_AT = '2026-11-02T00:00:00.000Z';

// Only the runtime session input is controlled. Events, history, revision and
// HTTP responses come from the production web server, with no child processes.
async function observeNodeAppAuthority({ consumerSamples = false } = {}) {
  let runtime;
  let records = [];
  return withAttachmentApp(async app => {
    await app.ready();
    const get = async url => {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, response.body);
      return { status: response.statusCode, data: response.json().data };
    };
    const realNow = Date.now;
    const publishedAt = realNow();
    let now = publishedAt;
    Date.now = () => now;
    try {
      const publish = (title, type) => {
        records = [{ id: 'app_authority', appId: 'terminal-tty', title, kind: 'tty', status: 'running',
          createdAt: CREATED_AT, updatedAt: CREATED_AT, workspace: { cwd: '/workspace' },
          paths: { sessionDir: '/tmp/session', logDir: '/tmp/logs' } }];
        runtime.emit(type, records[0]);
      };
      publish('Initial title', 'created');
      const initial = await get('/api/apps/sessions/state');
      const streamId = initial.data.streamId;
      const delta = (revision, stream = streamId) => get(`/api/apps/sessions?streamId=${stream}&sinceRevision=${revision}`);
      publish('Renamed', 'updated');
      const latest = await get('/api/apps/sessions/state');
      publish('Renamed', 'updated'); // No-op must not allocate another revision.
      const unchanged = await get('/api/apps/sessions/state');
      const within = await delta(0);
      const queries = async () => ({ current: await delta(2), wrongStream: await delta(1, 'wrong-stream'), future: await delta(3) });
      const before = await queries();
      const queryCases = {
        duplicateStream: `streamId=a&streamId=b&sinceRevision=1`,
        duplicateSince: `streamId=wrong&sinceRevision=1&sinceRevision=0`,
        fractional: `streamId=wrong&sinceRevision=1.5`,
        negative: `streamId=wrong&sinceRevision=-1`,
        nan: `streamId=wrong&sinceRevision=NaN`,
        infinity: `streamId=wrong&sinceRevision=Infinity`,
        emptySince: `streamId=wrong&sinceRevision=`,
        missingStream: `sinceRevision=1`,
        emptyStream: `streamId=&sinceRevision=1`,
        duplicateActual: `streamId=${encodeURIComponent(streamId)}&streamId=${encodeURIComponent(streamId)}&sinceRevision=1`,
        hex: `streamId=wrong&sinceRevision=0x10`,
      };
      const resyncResponses = {};
      for (const [name, query] of Object.entries(queryCases)) {
        const response = await app.inject({ method: 'GET', url: `/api/apps/sessions?${query}` });
        const body = response.json();
        resyncResponses[name] = { status: response.statusCode, body: body.data ?? body };
      }
      now = publishedAt + RETENTION_MS;
      const boundary = await delta(1);
      now += 1;
      const expired = await delta(1);
      const after = await queries();
      const recovered = await get('/api/apps/sessions/state');
      publish('After recovery', 'updated');
      const next = await delta(recovered.data.revision);
      const nextState = await get('/api/apps/sessions/state');
      assert.equal(initial.data.revision, 1);
      assert.equal(latest.data.revision, 2);
      assert.equal(unchanged.data.revision, 2);
      assert.deepEqual(recovered.data.snapshot.sessions, latest.data.snapshot.sessions);
      assert.deepEqual(next.data.events[0].payload.session, nextState.data.snapshot.sessions[0]);
      assert.equal(nextState.data.lastEventAt, next.data.events[0].payload.meta.generatedAt);

      if (consumerSamples) {
        // Keep real schema-valid wire values for the existing TS consumers.
        // Revisions 1/2 have expired; 3 is retained, so recovering from 1
        // requires an HTTP snapshot rather than an incomplete delta.
        const recoveryDelta = await delta(1);
        publish('After snapshot recovery', 'updated');
        const following = await delta(3);
        const final = await get('/api/apps/sessions/state');
        return {
          initial: initial.data,
          events: [...within.data.events, ...next.data.events, ...following.data.events],
          recoveryDelta: recoveryDelta.data,
          recovered: nextState.data,
          final: final.data,
        };
      }

      // Normalize only random identities and wall-clock strings. All other
      // fields (including full records, revisions, expiry cutoff and ordering)
      // stay in the golden. A trace is stable for a revision and distinct from
      // every other revision; stream identity is checked at every occurrence.
      const traces = new Map();
      function normalize(value, key = '') {
        if (key === 'streamId') { assert.equal(value, streamId); return '<stream>'; }
        if (key === 'traceId') return value;
        if (['lastEventAt', 'generatedAt'].includes(key) || (key === 'updatedAt' && value !== CREATED_AT)) {
          assert.ok(Number.isFinite(Date.parse(value))); return '<wall-clock>';
        }
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === 'object') {
          const result = {};
          for (const [name, item] of Object.entries(value)) {
            if (name === 'traceId') {
              const revision = value.revision;
              assert.match(item, /^aps_evt_/);
              if (traces.has(revision)) assert.equal(item, traces.get(revision));
              else { assert.ok(![...traces.values()].includes(item)); traces.set(revision, item); }
              result[name] = `<trace-${revision}>`;
            } else result[name] = normalize(item, name);
          }
          return result;
        }
        return value;
      }
      const resyncQueries = {};
      for (const [name, response] of Object.entries(resyncResponses)) {
        const normalized = normalize(response);
        if (normalized.body.instanceId) {
          assert.equal(normalized.body.instanceId, 'standalone');
          normalized.body.instanceId = '<instance>';
        }
        resyncQueries[name] = normalized;
      }
      const result = normalize({ initial, latest, unchanged, within, before, boundary, expired, after, recovered, next, nextState });
      result.resyncQueries = resyncQueries;
      return result;
    } finally { Date.now = realNow; }
  }, () => {
    const { AppRuntimeManager } = require('../../packages/app-runtime/src/runtime.ts');
    const { resolveStoragePaths } = require('../../packages/core/src/storage/paths.ts');
    runtime = new AppRuntimeManager(resolveStoragePaths());
    runtime.listSessions = () => records;
    return { appRuntime: runtime };
  });
}

module.exports = { observeNodeAppAuthority };
