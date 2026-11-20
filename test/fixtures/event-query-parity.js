const assert = require('node:assert/strict');
const path = require('node:path');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { connect } = require('./ai-session-authority-parity.js');

const eventsModule = require('../../packages/controlled-instance/src/web/events.ts');
const OriginalWebEventBus = eventsModule.WebEventBus;
let capturedBus;
let capturedEvents = [];
eventsModule.WebEventBus = class CapturingWebEventBus extends OriginalWebEventBus {
  constructor(...args) {
    super(...args);
    capturedBus = this;
    capturedEvents = [];
  }

  publish(type, payload) {
    const event = super.publish(type, payload);
    if (this === capturedBus) capturedEvents.push({ type, payload });
    return event;
  }
};

async function waitForStartupSnapshot() {
  const deadline = Date.now() + 3000;
  while (!capturedEvents.some(event => event.type === 'ai-session.snapshot' && event.payload?.meta?.reason === 'startup')) {
    if (Date.now() > deadline) throw new Error('controlled instance startup snapshot timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function seedSessions(root) {
  const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
  const registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
  registry.start({
    agent: 'codex', creationSource: 'ai-session', providerSessionId: 'provider-root',
    title: 'Root session', status: 'idle', phase: 'unknown',
  }, { timestamp: '2026-11-20T00:00:00.000Z' });
  registry.start({
    agent: 'codex', creationSource: 'ai-session', providerSessionId: 'provider-child',
    lineage: { kind: 'subagent', parentProviderSessionId: 'provider-root' },
    title: 'Child session', status: 'idle', phase: 'unknown',
  }, { timestamp: '2026-11-20T00:00:01.000Z' });
  return { aiSessionRegistry: registry };
}

function lineFor(snapshot, providerSessionId) {
  if (!snapshot) return null;
  const session = snapshot?.payload?.snapshot?.sessions?.find(candidate => (
    candidate.providerSessionId === providerSessionId
  ));
  assert.ok(session, `snapshot must contain ${providerSessionId}`);
  return session.lineage ?? null;
}

async function observeNodeEventQuery(scenario) {
  return withAttachmentApp(async app => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    assert.ok(capturedBus, 'controlled instance WebEventBus must be captured');
    await waitForStartupSnapshot();
    const base = `ws://127.0.0.1:${app.server.address().port}/api/events${scenario.query ? `?${scenario.query}` : ''}`;
    const client = await connect(base);
    try {
      const hello = await client.next();
      assert.equal(hello.type, 'streams.hello');
      capturedBus.publish('ai-session.message-delta', {
        instanceId: 'instance-query', sessionId: 'session-query', providerSessionId: 'provider-root',
        turnId: 'turn-query', itemId: 'item-query', delta: 'query-flag', generatedAt: '2026-11-20T00:00:02.000Z',
      });
      capturedBus.publish('parity.query-barrier', { scenario: scenario.name });

      const observed = [];
      for (;;) {
        const event = await client.next();
        if (event.type === 'parity.query-barrier') break;
        if (event.type === 'ai-session.snapshot' || event.type === 'ai-session.message-delta') {
          observed.push(event);
        }
      }
      const snapshot = observed.find(event => event.type === 'ai-session.snapshot');
      return {
        snapshotPresent: Boolean(snapshot),
        rootLineage: lineFor(snapshot, 'provider-root'),
        childLineage: lineFor(snapshot, 'provider-child'),
        transientDeltaDelivered: observed.some(event => event.type === 'ai-session.message-delta'),
      };
    } finally {
      await client.close();
    }
  }, seedSessions);
}

module.exports = { observeNodeEventQuery };
