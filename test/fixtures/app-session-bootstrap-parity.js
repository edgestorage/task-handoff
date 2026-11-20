const assert = require('node:assert/strict');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { connect } = require('./ai-session-authority-parity.js');

const CREATED_AT = '2026-11-02T00:00:00.000Z';

async function observeNodeAppBootstrap(renameBeforeConnect) {
  let runtime;
  let records = [];
  return withAttachmentApp(async app => {
    const publish = title => {
      records = [{ id: 'app_bootstrap', appId: 'terminal-tty', title, kind: 'tty', status: 'running',
        createdAt: CREATED_AT, updatedAt: CREATED_AT, workspace: { cwd: '/workspace' },
        paths: { sessionDir: '/tmp/session', logDir: '/tmp/logs' } }];
      runtime.emit(title === 'Initial title' ? 'created' : 'updated', records[0]);
    };
    const get = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/apps/sessions/state' });
      assert.equal(response.statusCode, 200);
      return response.json().data;
    };
    await app.listen({ host: '127.0.0.1', port: 0 });
    publish('Initial title');
    const initial = await get();
    if (renameBeforeConnect) publish('Before connect');
    const before = await get();
    const base = `ws://127.0.0.1:${app.server.address().port}`;
    const client = await connect(base + '/api/events?aiSessionAuthoritySnapshot=1');
    try {
      const hello = await client.next();
      assert.equal(hello.type, 'streams.hello');
      const aiSnapshot = await client.next();
      assert.equal(aiSnapshot.type, 'ai-session.snapshot');
      const management = await client.next();
      assert.equal(management.type, 'app.management');
      const descriptor = hello.payload.streams.find(value => value.topic === 'app.sessions');
      assert.equal(descriptor.streamId, before.streamId);
      assert.equal(descriptor.latestRevision, before.revision);
      publish('After connect');
      const patch = await client.next('app-session.patch');
      assert.equal(patch.topic, 'app.sessions');
      assert.equal(patch.v, 1);
      const after = await get();
      assert.equal(patch.payload.meta.previousRevision, before.revision);
      assert.equal(patch.payload.meta.revision, after.revision);
      assert.deepEqual(patch.payload.session, after.snapshot.sessions[0]);
      assert.equal(after.lastEventAt, patch.payload.meta.generatedAt);
      const streamId = before.streamId;
      const instanceId = descriptor.instanceId;
      const normalize = (value, key = '') => {
        if (key === 'streamId') { assert.equal(value, streamId); return '<stream>'; }
        if (key === 'instanceId') { assert.equal(value, instanceId); return '<instance>'; }
        if (key === 'traceId') { assert.match(value, /^aps_evt_/); return '<trace>'; }
        if (key === 'generatedAt' || key === 'lastEventAt' || (key === 'updatedAt' && value !== CREATED_AT)) {
          assert.ok(Number.isFinite(Date.parse(value))); return '<wall-clock>';
        }
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
        return value;
      };
      // The hello app descriptor, full HTTP states and full App patch payload
      // retain revisions and all session fields. Every consumed wire seq is
      // checked by connect(); unrelated management traffic may add seq gaps.
      return normalize({ initial, before, hello: { protocolVersion: hello.payload.protocolVersion, appStream: descriptor },
        bootstrapTypes: [hello.type, aiSnapshot.type, management.type], patch: { type: patch.type, topic: patch.topic, payload: patch.payload }, after });
    } finally { await client.close(); }
  }, () => {
    const { AppRuntimeManager } = require('../../packages/app-runtime/src/runtime.ts');
    const { resolveStoragePaths } = require('../../packages/core/src/storage/paths.ts');
    runtime = new AppRuntimeManager(resolveStoragePaths());
    runtime.listSessions = () => records;
    return { appRuntime: runtime };
  });
}

module.exports = { observeNodeAppBootstrap };
