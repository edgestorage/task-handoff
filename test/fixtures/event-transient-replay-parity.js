const assert = require('node:assert/strict');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { connect } = require('./ai-session-authority-parity.js');

const eventsModule = require('../../packages/controlled-instance/src/web/events.ts');
const OriginalWebEventBus = eventsModule.WebEventBus;
let capturedBus;
const CapturingWebEventBus = class CapturingWebEventBus extends OriginalWebEventBus {
  constructor(...args) {
    super(...args);
    capturedBus = this;
  }
};
eventsModule.WebEventBus = CapturingWebEventBus;

function projectReplay(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  return {
    type: event.type,
    replay: event.replay === true,
    instanceId: payload.instanceId ?? null,
    sessionId: payload.sessionId ?? null,
    itemId: item.id ?? payload.itemId ?? null,
    turnId: item.turnId ?? payload.turnId ?? null,
    status: item.status ?? null,
    summary: item.summary ?? null,
    delta: payload.delta ?? null,
    field: payload.field ?? null,
  };
}

async function observeNodeTransientReplay(scenario) {
  return withAttachmentApp(async app => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    assert.ok(capturedBus, 'controlled instance WebEventBus must be captured');
    const base = `ws://127.0.0.1:${app.server.address().port}/api/events?aiSessionTransient=1`;
    const client = await connect(base);
    try {
      const hello = await client.next();
      assert.equal(hello.type, 'streams.hello');
      for (const event of scenario.publish || []) capturedBus.publish(event.type, event.payload);
      client.socket.send(JSON.stringify({ v: 1, type: 'subscribe', ...scenario.subscribe }));
      await new Promise(resolve => setTimeout(resolve, 150));
      capturedBus.publish('ai-session.replay-barrier', { scenario: scenario.name });
      const replayed = [];
      for (;;) {
        const event = await client.next();
        if (event.type === 'ai-session.replay-barrier') break;
        if (event.replay === true) replayed.push(projectReplay(event));
      }
      return { replayed };
    } finally {
      await client.close();
    }
  });
}

module.exports = { observeNodeTransientReplay, projectReplay };
