const assert = require('node:assert/strict');
const path = require('node:path');
const { withAttachmentApp } = require('./attachment-route-parity.js');

const START = Date.parse('2026-11-05T00:00:00.000Z');
const RETENTION = 3600000;

async function observeNodeRemoval(timers) {
  const { WebEventBus } = require('../../packages/controlled-instance/src/web/events.ts');
  const { CodexAppServerSessionBridge } = require('../../packages/ai-session-runtime/src/codex-app-server.ts');
  const originalPublish = WebEventBus.prototype.publish;
  const originalArchive = CodexAppServerSessionBridge.prototype.archiveSession;
  const originalUnsubscribe = CodexAppServerSessionBridge.prototype.unsubscribeSession;
  const providerCalls = [], published = [], ids = new Map();
  let runtime, records = [], targetId, startupResolve;
  const startup = new Promise(resolve => { startupResolve = resolve; });
  timers.enable({ apis: ['Date'], now: START });
  WebEventBus.prototype.publish = function(type, payload, ...args) {
    const result = originalPublish.call(this, type, payload, ...args);
    if (/^(ai|app)-session\.(snapshot|patch|removed)$/.test(type)) {
      published.push(JSON.parse(JSON.stringify({ type, payload })));
      if (type === 'ai-session.snapshot' && payload.meta.revision === 1) startupResolve();
    }
    return result;
  };
  // Only the external provider operation is mocked; close coordinator,
  // history, registry removal, HTTP handler and authority publisher are real.
  CodexAppServerSessionBridge.prototype.archiveSession = async providerId => { providerCalls.push(['archive', providerId]); };
  CodexAppServerSessionBridge.prototype.unsubscribeSession = async providerId => { providerCalls.push(['unsubscribe', providerId]); };
  try {
    return await withAttachmentApp(async app => {
      await app.ready();
      let deadline;
      try {
        await Promise.race([startup, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('missing startup snapshot')), 3000);
        })]);
      } finally { clearTimeout(deadline); }
      const request = async (url, payload, method = 'GET') => {
        const response = await app.inject({ method, url, payload });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().data;
      };
      const state = topic => request(topic === 'ai' ? '/api/ai-sessions/state' : '/api/apps/sessions/state');
      const appRecord = (role, title) => ({ id: `app_${role}`, appId: 'terminal-tty', title,
        kind: 'tty', status: 'running', createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
        workspace: { cwd: '/workspace' }, paths: { sessionDir: `/tmp/${role}`, logDir: `/tmp/${role}-logs` } });
      records = [appRecord('target', 'Target'), appRecord('survivor', 'Survivor')];
      runtime.emit('created', records[0]);
      const output = { ai: { initial: await state('ai') }, app: { initial: await state('app') } };
      timers.setTime(START + 1000);
      await request(`/api/ai-sessions/${targetId}/story`, { storyId: 'story-before-removal' }, 'PUT');
      records[0] = appRecord('target', 'Renamed target');
      runtime.emit('updated', records[0]);
      for (const topic of ['ai', 'app']) output[topic].updated = await state(topic);
      timers.setTime(START + 2000);
      const close = await request(`/api/ai-sessions/${targetId}/close`, { clientRequestId: 'request-close' }, 'POST');
      const removedApp = records.shift();
      runtime.emit('deleted', removedApp);
      for (const topic of ['ai', 'app']) output[topic].removed = await state(topic);
      const repeat = await request(`/api/ai-sessions/${targetId}/close`, { clientRequestId: 'request-repeat' }, 'POST');
      runtime.emit('deleted', removedApp); // Repeated notification is a no-op.
      for (const topic of ['ai', 'app']) {
        output[topic].noop = await state(topic);
        assert.deepEqual(output[topic].noop, output[topic].removed);
        const streamId = output[topic].initial.streamId;
        const prefix = topic === 'ai' ? '/api/ai-sessions' : '/api/apps/sessions';
        output[topic].delta = await request(`${prefix}?streamId=${encodeURIComponent(streamId)}&sinceRevision=1`);
        output[topic].events = published.filter(event => event.type.startsWith(`${topic}-session.`));
        assert.equal(output[topic].events.length, 3);
      }
      for (const [name, offset] of [['boundaryDelta', 2000 + RETENTION], ['expiredDelta', 2001 + RETENTION]]) {
        timers.setTime(START + offset);
        for (const topic of ['ai', 'app']) {
          const prefix = topic === 'ai' ? '/api/ai-sessions' : '/api/apps/sessions';
          output[topic][name] = await request(`${prefix}?streamId=${encodeURIComponent(output[topic].initial.streamId)}&sinceRevision=2`);
        }
      }
      const streams = new Set();
      for (const topic of ['ai', 'app']) {
        const streamId = output[topic].initial.streamId;
        assert.ok(!streams.has(streamId)); streams.add(streamId);
        const traces = new Map();
        function normalize(value, key = '') {
          if (typeof value === 'string' && ids.has(value)) return ids.get(value);
          if (key === 'streamId') { assert.equal(value, streamId); return `${topic}-removal`; }
          if (Array.isArray(value)) return value.map(item => normalize(item));
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => {
            if (name !== 'traceId') return [name, normalize(item, name)];
            assert.match(item, new RegExp(`^${topic === 'ai' ? 'ais' : 'aps'}_evt_`));
            if (traces.has(value.revision)) assert.equal(traces.get(value.revision), item);
            else { assert.ok(![...traces.values()].includes(item)); traces.set(value.revision, item); }
            return [name, `<${topic}-trace-${value.revision}>`];
          }));
          return value;
        }
        output[topic] = normalize(output[topic]);
      }
      assert.deepEqual(providerCalls, [['archive', 'provider-target'], ['unsubscribe', 'provider-target']]);
      assert.equal(close.aiSessionId, targetId);
      assert.equal(repeat.aiSessionId, targetId);
      return { samples: output, sourceEffects: { close: { ...close, aiSessionId: ids.get(targetId) },
        repeat: { ...repeat, aiSessionId: ids.get(targetId) }, providerCalls } };
    }, root => {
      const { AppRuntimeManager } = require('../../packages/app-runtime/src/runtime.ts');
      const { resolveStoragePaths } = require('../../packages/core/src/storage/paths.ts');
      const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
      runtime = new AppRuntimeManager(resolveStoragePaths());
      runtime.listSessions = () => records;
      const registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
      for (const [role, offset] of [['target', -1000], ['survivor', -2000]]) {
        const id = registry.start({ agent: 'codex', creationSource: 'ai-session', providerSessionId: `provider-${role}`,
          title: role, cwd: '/workspace', status: 'idle', phase: 'unknown' }, { timestamp: new Date(START + offset).toISOString() }).id;
        assert.ok(!ids.has(id));
        ids.set(id, `ai_${role}`);
        if (role === 'target') targetId = id;
      }
      return { appRuntime: runtime, aiSessionRegistry: registry };
    });
  } finally {
    WebEventBus.prototype.publish = originalPublish;
    CodexAppServerSessionBridge.prototype.archiveSession = originalArchive;
    CodexAppServerSessionBridge.prototype.unsubscribeSession = originalUnsubscribe;
    timers.reset();
  }
}

module.exports = { observeNodeRemoval };
