const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { withAttachmentApp } = require('./attachment-route-parity.js');

// This contract projection keeps exact revisions, previousRevision, reason,
// stream identity and session references. Random stream/session IDs are mapped
// bijectively to one fixed name each (every occurrence must match its owner).
// Wall-clock strings and global envelope sequence gaps are not compared across
// implementations: unrelated app.management frames share that sequence. Each
// connection still asserts strictly increasing envelope seq, and state time
// must equal the latest authority event's generatedAt.
function projection(streamId, sessionId) {
  let instanceId;
  const session = value => {
    assert.equal(value.id, sessionId);
    assert.equal(value.providerSessionId, 'provider-authority');
    return { id: '<session>', providerSessionId: value.providerSessionId, title: value.title, status: value.status,
      unread: value.unread, ...(value.storyId === undefined ? {} : { storyId: value.storyId }) };
  };
  const snapshot = value => ({ runningCount: value.runningCount, waitingCount: value.waitingCount,
    staleCount: value.staleCount, sessions: value.sessions.map(session) });
  const stream = value => { assert.equal(value, streamId); return '<stream>'; };
  const event = value => {
    instanceId ??= value.payload.meta.instanceId;
    assert.equal(value.payload.meta.instanceId, instanceId);
    assert.ok(Number.isFinite(Date.parse(value.payload.meta.generatedAt)));
    return ({ type: value.type, payload: {
    meta: { streamId: stream(value.payload.meta.streamId), revision: value.payload.meta.revision,
      ...(value.payload.meta.previousRevision === undefined ? {} : { previousRevision: value.payload.meta.previousRevision }),
      reason: value.payload.meta.reason },
    ...(value.payload.snapshot ? { snapshot: snapshot(value.payload.snapshot) } : {
      upserted: value.payload.upserted.map(session), removed: value.payload.removed.map(id => {
        assert.equal(id, sessionId); return '<session>';
      }),
    }),
  } });
  };
  return {
    state: value => ({ streamId: stream(value.streamId), revision: value.revision, snapshot: snapshot(value.snapshot) }),
    event,
    delta: value => { assert.equal(value.instanceId, instanceId); return ({ streamId: stream(value.streamId), sinceRevision: value.sinceRevision,
      latestRevision: value.latestRevision, earliestRetainedRevision: value.earliestRetainedRevision,
      syncRequired: value.syncRequired, events: value.events.map(event) }); },
  };
}

async function connect(url) {
  const socket = new WebSocket(url);
  const queue = [];
  let wake;
  let previousSeq = 0;
  socket.on('message', bytes => {
    const value = JSON.parse(String(bytes));
    queue.push(value);
    if (wake) { wake(); wake = undefined; }
  });
  await once(socket, 'open');
  return { socket, async next(type) {
    let timer;
    try { return await Promise.race([
      (async () => {
        for (;;) {
          while (queue.length) {
            const value = queue.shift();
            assert.ok(value.seq > previousSeq, 'wire sequence must increase');
            previousSeq = value.seq;
            if (type === undefined || value.type === type) return value;
          }
          await new Promise(resolve => { wake = resolve; });
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`missing ${type}`)), 3000);
        timer.unref();
      }),
    ]); } finally { clearTimeout(timer); }
  }, async close() {
    const closed = once(socket, 'close'); socket.close(); await closed;
  } };
}

async function observeNodeAuthority() {
  let registry, sessionId;
  return withAttachmentApp(async app => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (url, body) => {
      const response = await fetch(base + url, body === undefined ? {} : {
        method: url.endsWith('/story') ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    };
    const read = () => request(`/api/ai-sessions/${sessionId}/read`, {});
    const mutate = storyId => request(`/api/ai-sessions/${sessionId}/story`, { storyId });
    // Force the first authoritative publish through a real control route.
    await read();
    const initial = await request('/api/ai-sessions');
    assert.equal(initial.revision, 1);
    assert.equal(initial.snapshot.sessions.length, 1);
    const p = projection(initial.streamId, sessionId);
    let client;
    try {
      client = await connect(base.replace('http:', 'ws:') + '/api/events?aiSessionAuthoritySnapshot=1');
      const hello = await client.next('streams.hello');
      const descriptor = hello.payload.streams.find(value => value.topic === 'ai.sessions');
      assert.equal(descriptor.streamId, initial.streamId);
      assert.equal(descriptor.latestRevision, initial.revision);
      const bootstrap = await client.next('ai-session.snapshot');
      assert.deepEqual(p.event(bootstrap).payload.snapshot, p.state(initial).snapshot);
      await mutate('story-one');
      const patch = await client.next('ai-session.patch');
      const after = await request('/api/ai-sessions/state');
      assert.equal(after.lastEventAt, patch.payload.meta.generatedAt);
      await read(); // Already read: no summary change, no revision increase.
      const unchanged = await request('/api/ai-sessions');
      assert.deepEqual(unchanged, after);
      await client.close(); client = undefined;
      await mutate('story-offline');
      const recovered = await request('/api/ai-sessions/state');
      client = await connect(base.replace('http:', 'ws:') + '/api/events?aiSessionAuthoritySnapshot=1');
      const reconnectHello = await client.next('streams.hello');
      assert.equal(reconnectHello.payload.streams.find(v => v.topic === 'ai.sessions').latestRevision, recovered.revision);
      const reconnect = await client.next('ai-session.snapshot');
      assert.deepEqual(p.event(reconnect).payload.snapshot, p.state(recovered).snapshot);
      await mutate('story-after-reconnect');
      const next = await client.next('ai-session.patch');
      const latest = await request('/api/ai-sessions');
      assert.equal(latest.lastEventAt, next.payload.meta.generatedAt);
      const delta = (revision, stream = initial.streamId) => request(`/api/ai-sessions?streamId=${encodeURIComponent(stream)}&sinceRevision=${revision}`);
      const missed = await delta(2);
      assert.deepEqual(missed.events[1].payload, next.payload);
      assert.deepEqual(p.event(missed.events[0]).payload.upserted, p.state(recovered).snapshot.sessions);
      const observeQuery = async query => {
        const response = await app.inject({ method: 'GET', url: `/api/ai-sessions?${query}` });
        const body = response.json();
        if (body.data) {
          return { status: response.statusCode, body: body.data.events ? p.delta(body.data) : p.state(body.data) };
        }
        return { status: response.statusCode, body };
      };
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
        duplicateActual: `streamId=${encodeURIComponent(initial.streamId)}&streamId=${encodeURIComponent(initial.streamId)}&sinceRevision=1`,
        hex: `streamId=wrong&sinceRevision=0x10`,
      };
      const resyncQueries = {};
      for (const [name, query] of Object.entries(queryCases)) resyncQueries[name] = await observeQuery(query);
      const observeState = async query => {
        const response = await app.inject({ method: 'GET', url: `/api/ai-sessions/state${query ? `?${query}` : ''}` });
        return { status: response.statusCode, body: p.state(response.json().data) };
      };
      const stateQueries = {
        current: await observeState(''),
        subagents: await observeState('hierarchy=subagents'),
        duplicateHierarchy: await observeState('hierarchy=subagents&hierarchy=subagents'),
        caseSensitive: await observeState('hierarchy=SUBAGENTS'),
      };
      const result = { initial: p.state(initial), bootstrap: p.event(bootstrap), patch: p.event(patch),
        after: p.state(after), unchanged: p.state(unchanged), recovered: p.state(recovered),
        reconnect: p.event(reconnect), next: p.event(next), latest: p.state(latest),
        missed: p.delta(missed), current: p.delta(await delta(4)),
        wrongStream: p.delta(await delta(2, 'wrong-stream')), future: p.delta(await delta(5)), resyncQueries, stateQueries };
      // No new authority event. Advance only the retention clock, then invoke
      // the production HTTP handler; restore before cleanup/timers can run.
      const realNow = Date.now;
      try {
        const advanced = realNow() + 60 * 60 * 1000 + 1;
        Date.now = () => advanced;
        const response = await app.inject({ method: 'GET', url: `/api/ai-sessions?streamId=${initial.streamId}&sinceRevision=2` });
        assert.equal(response.statusCode, 200);
        result.expired = p.delta(response.json().data);
      } finally { Date.now = realNow; }
      return result;
    } finally { if (client) await client.close(); }
  }, root => {
    const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
    registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
    const session = registry.start({ agent: 'codex', creationSource: 'ai-session', providerSessionId: 'provider-authority', title: 'Initial title',
      status: 'idle', phase: 'unknown', unread: true }, { timestamp: '2026-11-02T00:00:00.000Z' });
    sessionId = session.id;
    return { aiSessionRegistry: registry };
  });
}
module.exports = { observeNodeAuthority, connect };
