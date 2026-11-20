#!/usr/bin/env node
// Minimal OpenCode HTTP/SSE fixture used by migration evidence scripts. It
// implements only the endpoints the controlled-instance provider clients call
// and turns prompt_async into a deterministic assistant stream.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const debugPath = process.env.FAKE_OPENCODE_DEBUG_LOG;
const debug = debugPath && fs.createWriteStream(path.resolve(debugPath), { flags: 'a' });
function trace(line) {
  debug?.write(`${new Date().toISOString()} ${line}\n`);
}

const args = process.argv.slice(2);
const portIndex = args.findIndex(value => value === '--port' || value.startsWith('--port='));
const portValue = portIndex < 0
  ? undefined
  : args[portIndex].includes('=')
    ? args[portIndex].slice('--port='.length)
    : args[portIndex + 1];
const port = Number(portValue);
if (!Number.isInteger(port) || port <= 0) {
  console.error('fake-opencode: missing --port');
  process.exit(2);
}
const holdTurn = process.env.FAKE_OPENCODE_HOLD === '1';
const failReconcile = process.env.FAKE_OPENCODE_FAIL_RECONCILE === '1';
let messageReadFailure = false;

const sessions = new Map();
const statuses = new Map();
const messages = new Map();
const sseClients = new Set();
let sessionSequence = 0;
let waiters = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function emit(event) {
  trace(`emit ${event.payload?.type} sse=${sseClients.size}`);
  const frame = `data: ${JSON.stringify(event)}\r\n\r\n`;
  for (const client of sseClients) client.write(frame);
}

function nextSseClient(timeoutMs = 5000) {
  if (sseClients.size > 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiters = waiters.filter(entry => entry !== waiter);
      resolve();
    }, timeoutMs);
    const waiter = () => { clearTimeout(timer); resolve(); };
    waiters.push(waiter);
  });
}

function sessionView(session) {
  return { ...session, time: { ...session.time } };
}

function touch(session) {
  session.time.updated = Date.now();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const directory = url.searchParams.get('directory') || '';
  if (url.pathname === '/global/health') {
    return json(res, 200, { healthy: true, version: '1.18.30-fixture' });
  }
  if (url.pathname === '/global/event') {
    trace('sse connect');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': fixture\r\n\r\n');
    sseClients.add(res);
    for (const waiter of waiters.splice(0)) waiter();
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/experimental/session') {
    return json(res, 200, [...sessions.values()].map(sessionView));
  }
  if (url.pathname === '/session') {
    if (req.method === 'GET') {
      return json(res, 200, [...sessions.values()].filter(session => session.directory === directory).map(sessionView));
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const created = {
        id: `ses_fixture_${++sessionSequence}`,
        projectID: 'proj_fixture',
        directory,
        title: 'Fixture session',
        version: '1.18.30-fixture',
        time: { created: Date.now(), updated: Date.now() },
        ...(body ? { permission: JSON.parse(body).permission || [] } : {}),
      };
      sessions.set(created.id, created);
      statuses.set(created.id, { type: 'idle' });
      messages.set(created.id, { count: 0 });
      return json(res, 200, sessionView(created));
    }
  }
  if (url.pathname === '/session/status') {
    const body = {};
    for (const [id, status] of statuses) body[id] = status;
    return json(res, 200, body);
  }
  if (url.pathname === '/permission') return json(res, 200, []);
  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) {
    const session = sessions.get(decodeURIComponent(sessionMatch[1]));
    if (!session) return json(res, 404, { error: 'session not found' });
    if (req.method === 'GET') return json(res, 200, sessionView(session));
    if (req.method === 'PATCH') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = body ? JSON.parse(body) : {};
      if (typeof patch.title === 'string') session.title = patch.title;
      if (patch.time && typeof patch.time.archived === 'number') session.time.archived = patch.time.archived;
      touch(session);
      return json(res, 200, sessionView(session));
    }
    if (req.method === 'DELETE') {
      sessions.delete(session.id);
      return json(res, 200, true);
    }
  }
  const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (promptMatch && req.method === 'POST') {
    const session = sessions.get(decodeURIComponent(promptMatch[1]));
    if (!session) return json(res, 404, { error: 'session not found' });
    let body = '';
    for await (const chunk of req) body += chunk;
    await nextSseClient();
    const prompt = body ? JSON.parse(body) : {};
    const text = (prompt.parts || [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
    trace(`prompt ${session.id} sse=${sseClients.size} text=${JSON.stringify(text)}`);
    const userID = String(prompt.messageID || `msg_user_${Date.now()}`);
    const assistantID = `msg_assistant_${userID}`;
    const partID = `part_answer_${userID}`;
    const created = Date.now();
    if (failReconcile) messageReadFailure = true;
    statuses.set(session.id, { type: 'busy' });
    emit({ directory: session.directory, payload: { type: 'session.status', properties: { sessionID: session.id, status: { type: 'busy' } } } });
    emit({ directory: session.directory, payload: { type: 'message.updated', properties: { info: {
      id: userID, sessionID: session.id, role: 'user', time: { created },
    } } } });
    emit({ directory: session.directory, payload: { type: 'message.updated', properties: { info: {
      id: assistantID, sessionID: session.id, role: 'assistant', parentID: userID, time: { created: created + 1 },
    } } } });
    emit({ directory: session.directory, payload: { type: 'message.part.updated', properties: { part: {
      id: partID, sessionID: session.id, messageID: assistantID, type: 'text', text: '',
    } } } });
    emit({ directory: session.directory, payload: { type: 'message.part.delta', properties: {
      sessionID: session.id, messageID: assistantID, partID, field: 'text', delta: text,
    } } });
    emit({ directory: session.directory, payload: { type: 'message.part.updated', properties: { part: {
      id: partID, sessionID: session.id, messageID: assistantID, type: 'text', text,
    } } } });
    messages.set(session.id, {
      count: 2,
      entries: [
        { info: { id: userID, sessionID: session.id, role: 'user', time: { created } }, parts: [
          { id: `part_user_${userID}`, sessionID: session.id, messageID: userID, type: 'text', text },
        ] },
        { info: { id: assistantID, sessionID: session.id, role: 'assistant', parentID: userID, time: { created: created + 1, ...(holdTurn ? {} : { completed: created + 2 }) } }, parts: [
          { id: partID, sessionID: session.id, messageID: assistantID, type: 'text', text },
        ] },
      ],
    });
    touch(session);
    if (holdTurn) {
      trace(`hold ${session.id}`);
    } else {
      emit({ directory: session.directory, payload: { type: 'message.updated', properties: { info: {
        id: assistantID, sessionID: session.id, role: 'assistant', parentID: userID, time: { created: created + 1, completed: created + 2 },
      } } } });
      statuses.set(session.id, { type: 'idle' });
      emit({ directory: session.directory, payload: { type: 'session.status', properties: { sessionID: session.id, status: { type: 'idle' } } } });
    }
    res.writeHead(204);
    res.end();
    return;
  }
  const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'GET') {
    if (messageReadFailure) {
      return json(res, 500, { error: 'fixture reconcile failure' });
    }
    const stored = messages.get(decodeURIComponent(messageMatch[1]));
    return json(res, 200, stored?.entries || []);
  }
  const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (abortMatch && req.method === 'POST') {
    const id = decodeURIComponent(abortMatch[1]);
    if (statuses.has(id)) statuses.set(id, { type: 'idle' });
    return json(res, 200, true);
  }
  const replyMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
  if (replyMatch && req.method === 'POST') return json(res, 200, true);
  return json(res, 404, { error: `fake-opencode: ${req.method} ${url.pathname}` });
});

server.on('error', error => {
  console.error(`fake-opencode: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-opencode listening on ${port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
