const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const WebSocket = require('ws');
const { registerWorkspaceRequire } = require('../workspace-require.js');

registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { NodeAgentInstanceEventForwarder } = require('../../packages/node-agent/src/events.ts');
const { ControlPlaneEventBus } = require('../../packages/control-plane/src/control-plane/events/bus.ts');
const { ControlPlaneNodeAgentTunnelTransport } = require('../../packages/control-plane/src/control-plane/nodes/tunnel.ts');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class ForwarderOutput extends EventEmitter {
  constructor(nodeId, tunnel, frames) {
    super();
    this.OPEN = WebSocket.OPEN;
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.nodeId = nodeId;
    this.tunnel = tunnel;
    this.frames = frames;
  }

  send(value) {
    const message = JSON.parse(String(value));
    this.frames.push(message);
    this.tunnel.handleMessage(this.nodeId, message);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

async function observeEventForwarder({
  base,
  workspace,
  appId = 'terminal-tty',
  nodeId = 'node_event_forwarder',
  instanceId = 'inst_differential',
  validateInstanceScope = async () => true,
}) {
  const connectedUrls = [];
  const forwardedFrames = [];
  const cpEvents = [];
  const hellos = [];
  const bus = new ControlPlaneEventBus();
  bus.on(event => cpEvents.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(bus, {
    validateInstanceScope,
    onStreamsHello: (instanceId, hello) => hellos.push({ instanceId, hello }),
  });
  const output = new ForwarderOutput(nodeId, tunnel, forwardedFrames);
  const instance = { id: instanceId, ready: true, target: { api: base } };
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => [instance] },
    undefined,
    {
      safetyIntervalMs: 60_000,
      createSocket: (url, options) => {
        connectedUrls.push(url);
        return new WebSocket(url, options);
      },
    },
  );

  try {
    forwarder.addOutput(output, { expectsTransientSubscription: true });
    assert.equal(forwarder.setOutputSubscription(output, {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: true,
      timelineSessions: [],
    }), true);
    forwarder.start();

    await waitFor(() => hellos.some(entry => entry.instanceId === instanceId), 'Control Plane streams hello');
    try {
      await waitFor(() => cpEvents.some(event => event.type === 'ai-session.snapshot'), 'forwarded AI Session authority snapshot');
    } catch (error) {
      console.error('forwarder diagnostics', JSON.stringify({
        urls: connectedUrls,
        frames: forwardedFrames,
        cpEvents,
      }, null, 2));
      throw error;
    }

    const launch = await fetch(`${base}/api/apps/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId,
        title: 'Rust event forwarder session',
        args: process.platform === 'win32' ? ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 > nul'] : ['-c', 'sleep 30'],
        cwd: workspace,
      }),
    });
    const launched = await launch.json();
    assert.equal(launch.status, 200, JSON.stringify(launched));
    const appSessionId = launched.data.id;
    await waitFor(() => cpEvents.some(event => event.type === 'app-session.patch' || event.type === 'app-session.snapshot'), 'forwarded App Session event');
    const firstAppSessionEventType = cpEvents.find(event => event.type === 'app-session.patch' || event.type === 'app-session.snapshot')?.type;

    const replayOutput = new ForwarderOutput(nodeId, tunnel, forwardedFrames);
    forwarder.addOutput(replayOutput, { expectsTransientSubscription: true });
    assert.equal(forwarder.setOutputSubscription(replayOutput, {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: true,
      timelineSessions: [],
    }), true);
    await waitFor(() => hellos.length >= 2, 'replayed Control Plane streams hello');
    await waitFor(() => cpEvents.filter(event => event.type === 'ai-session.snapshot').length >= 2, 'replayed AI Session authority snapshot');
    await waitFor(() => cpEvents.filter(event => event.type === 'app-session.snapshot').length >= 2, 'replayed App Session authority snapshot');

    const stop = await fetch(`${base}/api/apps/sessions/${encodeURIComponent(appSessionId)}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200, await stop.text());
    await waitFor(() => cpEvents.some(event => event.type === 'app-session.removed'), 'forwarded stopped App Session');
    const connected = new URL(connectedUrls[0]);
    return {
      query: {
        aiSessionTransient: connected.searchParams.get('aiSessionTransient'),
        aiSessionAuthoritySnapshot: connected.searchParams.get('aiSessionAuthoritySnapshot'),
        aiSessionHierarchy: connected.searchParams.get('aiSessionHierarchy'),
      },
      helloCount: hellos.length,
      forwardedTypes: [...new Set(forwardedFrames
        .filter(message => message.type === 'node-agent.event.forwarded')
        .map(message => message.event?.type)
        .filter(Boolean))],
      cpEventTypes: [...new Set(cpEvents.map(event => event.type))],
      firstAppSessionEventType,
      appSessionEventTypes: cpEvents
        .filter(event => event.type.startsWith('app-session.'))
        .map(event => event.type),
      appSessionId,
    };
  } finally {
    forwarder.stop();
    output.close();
  }
}

async function observeUnownedForwarder({
  base,
  workspace,
  appId = 'terminal-tty',
  nodeId = 'node_event_forwarder_unowned',
  instanceId = 'inst_differential',
  validateInstanceScope = async () => false,
}) {
  const forwardedFrames = [];
  const cpEvents = [];
  const hellos = [];
  const bus = new ControlPlaneEventBus();
  bus.on(event => cpEvents.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(bus, {
    validateInstanceScope,
    onStreamsHello: (instanceId, hello) => hellos.push({ instanceId, hello }),
  });
  const output = new ForwarderOutput(nodeId, tunnel, forwardedFrames);
  const instance = { id: instanceId, ready: true, target: { api: base } };
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => [instance] },
    undefined,
    {
      safetyIntervalMs: 60_000,
      createSocket: (url, options) => new WebSocket(url, options),
    },
  );

  try {
    forwarder.addOutput(output, { expectsTransientSubscription: true });
    assert.equal(forwarder.setOutputSubscription(output, {
      messageDeltas: { allInstances: true, instanceIds: [] },
      timelineAllSessions: true,
      timelineSessions: [],
    }), true);
    forwarder.start();
    await waitFor(
      () => forwardedFrames.some(message => message.type === 'node-agent.streams.hello'),
      'producer streams hello before Control Plane ownership',
    );

    const launch = await fetch(`${base}/api/apps/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId,
        title: 'Unowned Rust event forwarder session',
        args: process.platform === 'win32' ? ['/d', '/s', '/c', 'ping -n 30 127.0.0.1 > nul'] : ['-c', 'sleep 30'],
        cwd: workspace,
      }),
    });
    const launched = await launch.json();
    assert.equal(launch.status, 200, JSON.stringify(launched));
    try {
      await waitFor(
        () => forwardedFrames.some(message => (
          message.type === 'node-agent.event.forwarded'
          && String(message.event?.type || '').startsWith('app-session.')
        )),
        'producer App Session event before Control Plane ownership',
      );
    } catch (error) {
      console.error('unowned forwarder diagnostics', JSON.stringify({
        nodeId,
        instanceId,
        launched,
        frames: forwardedFrames,
        cpEvents,
        hellos,
      }, null, 2));
      throw error;
    }
    await sleep(300);

    const stop = await fetch(`${base}/api/apps/sessions/${encodeURIComponent(launched.data.id)}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200, await stop.text());
    return {
      helloCount: hellos.length,
      forwardedAppSessionTypes: [...new Set(forwardedFrames
        .filter(message => message.type === 'node-agent.event.forwarded')
        .map(message => message.event?.type)
        .filter(type => String(type || '').startsWith('app-session.')))],
      cpEventTypes: [...new Set(cpEvents.map(event => event.type))],
    };
  } finally {
    forwarder.stop();
    output.close();
  }
}

module.exports = { observeEventForwarder, observeUnownedForwarder };
