const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { readonly } = require('./attachment-commit-parity.js');
const { files } = require('./history-retention-parity.js');
const { input } = require('./attachment-read-gc-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { WebEventBus } = require('../../packages/controlled-instance/src/web/events.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const HOUR = 3600000;
function seed(root) {
  const seedTime = new Date().toISOString(), attachment = input.attachment;
  const hash = crypto.createHash('sha256').update('read bytes').digest('hex');
  const manifest = { schemaVersion: 1, id: attachment.id, inputId: 'input-read', sessionId: input.session.id, messageId: 'message-read', turnId: 'turn-read',
    kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, blobHash: hash, sourceType: 'inline', state: 'committed', createdAt: seedTime, committedAt: seedTime };
  for (const [relative, bytes] of Object.entries({ [`ai-session-attachments/manifests/${attachment.id}.json`]: JSON.stringify(manifest, null, 2) + '\n',
    [`ai-session-attachments/blobs/${hash}`]: 'read bytes', [`ai-sessions/${input.session.id}.json`]: JSON.stringify(input.session) })) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  return seedTime;
}
// Keep the production registration, interval identity, unref and cancellation.
// Only the recorded hourly callback is driven explicitly; other timers run normally.
function scheduler() {
  const interval = global.setInterval, clear = global.clearInterval;
  let entry;
  global.setInterval = (callback, delay, ...args) => {
    const handle = interval(callback, delay, ...args);
    if (delay === HOUR) { assert.equal(entry, undefined); entry = { callback: () => callback(...args), handle, active: true, delay }; }
    return handle;
  };
  global.clearInterval = handle => { if (entry?.handle === handle) entry.active = false; return clear(handle); };
  return { get entry() { assert.ok(entry, 'actual server must register hourly GC'); return entry; },
    tick() { const entry = this.entry; if (entry.active) entry.callback(); },
    queued() { this.entry.callback(); },
    restore() { if (entry) clear(entry.handle); global.setInterval = interval; global.clearInterval = clear; } };
}
function normalize(output, seedTime, start, end) {
  const state = output.initial.body.data, stream = state.streamId;
  const events = output.events, times = new Map(), traces = new Map(); let gc;
  for (const event of events) {
    assert.equal(event.payload.meta.instanceId, 'standalone');
    times.set(event.payload.meta.revision, event.payload.meta.generatedAt);
    traces.set(event.payload.meta.traceId, `<trace-${traces.size + 1}>`);
  }
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'streamId') { assert.equal(child, stream); value[key] = '<stream>'; }
      else if (key === 'instanceId') { assert.equal(child, 'standalone'); value[key] = '<instance>'; }
      else if (key === 'traceId') { assert.ok(traces.has(child)); value[key] = traces.get(child); }
      else if (key === 'generatedAt' || key === 'lastEventAt') {
        assert.ok(Date.parse(child) >= start && Date.parse(child) <= end); assert.equal(child, times.get(value.revision)); value[key] = `<event-${value.revision}>`;
      } else if (key === 'updatedAt' && value.sessions) {
        assert.ok(Date.parse(child) >= start && Date.parse(child) <= end); value[key] = '<snapshot-time>';
      } else if ((key === 'createdAt' || key === 'committedAt') && child === seedTime) value[key] = '<seed-time>';
      else if (key === 'contentDeletedAt') { assert.ok(Date.parse(child) >= start && Date.parse(child) <= end); gc ??= child; assert.equal(child, gc); value[key] = '<gc-time>'; }
      else walk(child);
    }
  };
  walk(output); return output;
}
async function observeBackgroundGc(name) {
  const start = Date.now(), observed = new EventEmitter(), events = [];
  let owner, registry, rootPath, seedTime, restore;
  const driver = scheduler(), originalGc = AiSessionConversationAttachmentStore.prototype.gc, originalPublish = WebEventBus.prototype.publish;
  AiSessionConversationAttachmentStore.prototype.gc = function(...args) { if (rootPath && this.root === path.join(rootPath, 'ai-session-attachments')) owner = this; return originalGc.apply(this, args); };
  WebEventBus.prototype.publish = function(type, payload) {
    const event = originalPublish.call(this, type, payload);
    if (type === 'ai-session.snapshot' || type === 'ai-session.patch') { events.push(clone({ type, payload: event.payload })); observed.emit(type); }
    return event;
  };
  try {
    return await withAttachmentApp(async (app, root) => {
      await app.ready(); assert.ok(owner); registry.conversationAttachments = owner;
      await new Promise(setImmediate); await new Promise(setImmediate);
      const warnings = [];
      const warn = app.log.warn.bind(app.log);
      app.log.warn = (...args) => { if (args[0]?.err?.code === 'AI_SESSION_ATTACHMENT_IO_FAILED') warnings.push(args[0].err); return warn(...args); };
      const get = async url => { const response = await app.inject({ method: 'GET', url }); return { status: response.statusCode, body: response.json() }; };
      const state = () => get('/api/ai-sessions/state');
      const capture = () => ({ files: files(root), rawTurns: clone(registry.get(input.session.id).turns),
        attachments: owner.projectMessageAttachments(input.session.id, 'message-read', [input.attachment]) });
      const output = { intervalMs: driver.entry.delay, initial: await state(), before: capture() };
      assert.equal(output.initial.body.data.revision, 1);
      if (name === 'C01') { driver.tick(); output.retained = { state: await state(), disk: capture() }; }
      restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
      assert.throws(() => owner.setRetentionDays(0), error => error.code === 'AI_SESSION_ATTACHMENT_IO_FAILED');
      assert.deepEqual(capture(), output.before);
      if (name === 'C02') {
        let error;
        try { driver.tick(); } catch (caught) { error = { code: caught.code, message: caught.message }; }
        output.failure = { ...(error ? { thrown: error } : {}), state: await state(), disk: capture() };
        output.failureWarningCount = warnings.length;
      }
      restore(); restore = undefined;
      if (name === 'C03') {
        await app.close(); output.timerStopped = !driver.entry.active;
        output.closed = capture(); driver.queued(); output.afterQueued = capture();
      } else {
        const patch = once(observed, 'ai-session.patch', { signal: AbortSignal.timeout(3000) });
        driver.tick(); await patch;
        output.expired = { state: await state(), disk: capture() };
        driver.tick(); output.repeated = { state: await state(), disk: capture() };
        output.delta = await get(`/api/ai-sessions?streamId=${output.initial.body.data.streamId}&sinceRevision=1`);
        await app.close(); output.timerStopped = !driver.entry.active;
      }
      const reopened = new AiSessionConversationAttachmentStore({ dataDir: root });
      output.reopened = { files: files(root), attachments: reopened.attachmentsForMessage(input.session.id, 'message-read') };
      output.events = events;
      console.error(`U03.12 ${name}: ${JSON.stringify({ failure: output.failure?.thrown, warnings: output.failureWarningCount, stopped: output.timerStopped, revisions: events.map(e => e.payload.meta.revision), attachments: output.reopened.attachments })}`);
      return normalize(output, seedTime, start, Date.now());
    }, root => { rootPath = root; seedTime = seed(root); registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
      return { aiSessionRegistry: registry, aiSessionDiscovery: { register() {}, async refresh() {} } }; });
  } finally { restore?.(); driver.restore(); AiSessionConversationAttachmentStore.prototype.gc = originalGc; WebEventBus.prototype.publish = originalPublish; }
}
function assertBackground(name, output) {
  assert.equal(output.intervalMs, HOUR); assert.equal(output.timerStopped, true);
  if (name === 'C03') { assert.deepEqual(output.closed, output.before); assert.deepEqual(output.afterQueued, output.closed); assert.equal(output.events.length, 1); assert.equal(output.reopened.attachments[0].contentState, 'available'); }
  else {
    assert.equal(output.expired.state.body.data.revision, 2); assert.deepEqual(output.repeated, output.expired);
    assert.equal(output.expired.disk.attachments[0].contentState, 'expired'); assert.deepEqual(output.expired.disk.rawTurns, output.before.rawTurns);
    assert.equal(output.events.length, 2); assert.equal(output.events[1].payload.meta.previousRevision, 1);
    assert.deepEqual(output.delta.body.data.events, [output.events[1]]); assert.deepEqual(output.reopened.files, output.expired.disk.files);
    if (name === 'C01') { assert.deepEqual(output.retained.state, output.initial); assert.deepEqual(output.retained.disk, output.before); }
    if (name === 'C02') { assert.equal(output.failure.thrown, undefined); assert.equal(output.failureWarningCount, 1); assert.deepEqual(output.failure.state, output.initial); assert.deepEqual(output.failure.disk, output.before); }
  }
}
// Reproduce uncaught timer failure in a process owned only by this test. No
// uncaughtException handler: a thrown production callback must determine exit.
async function crashProbe() {
  const originalGc = AiSessionConversationAttachmentStore.prototype.gc, interval = global.setInterval;
  let owner, rootPath, armed = false, restore, finish;
  const fired = new Promise(resolve => { finish = resolve; });
  AiSessionConversationAttachmentStore.prototype.gc = function(...args) { if (rootPath && this.root === path.join(rootPath, 'ai-session-attachments')) owner = this; return originalGc.apply(this, args); };
  global.setInterval = (callback, delay, ...args) => interval(delay === HOUR ? () => { if (armed) { armed = false; callback(...args); finish(); } } : callback, delay === HOUR ? 10 : delay, ...args);
  let timer;
  try {
    await withAttachmentApp(async (app, root) => {
      await app.ready(); restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
      assert.throws(() => owner.setRetentionDays(0), error => error.code === 'AI_SESSION_ATTACHMENT_IO_FAILED');
      armed = true;
      await Promise.race([fired, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GC interval did not execute')), 3000); })]);
      restore(); restore = undefined;
      console.log(JSON.stringify({ survived: true }));
    }, root => { rootPath = root; console.log(JSON.stringify({ probeRoot: root })); seed(root); return { aiSessionDiscovery: { register() {}, async refresh() {} } }; });
  } finally { clearTimeout(timer); restore?.(); global.setInterval = interval; AiSessionConversationAttachmentStore.prototype.gc = originalGc; }
}
function runCrashProbe() {
  const child = spawnSync(process.execPath, ['--import', path.resolve(__dirname, '../setup-isolated-runtime.mjs'), __filename, '--crash-probe'],
    { encoding: 'utf8', timeout: 20000 });
  const messages = child.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const roots = messages.filter(message => message.probeRoot).map(message => message.probeRoot);
  assert.equal(roots.length, 1, child.stderr);
  for (const root of roots) {
    assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^attachment-route-parity-/);
    if (fs.existsSync(root)) {
      const manifests = path.join(root, 'ai-session-attachments/manifests');
      if (fs.existsSync(manifests)) fs.chmodSync(manifests, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(root), false);
  }
  return { status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr,
    survived: messages.some(message => message.survived === true) };
}
module.exports = { observeBackgroundGc, assertBackground, runCrashProbe, input };
if (process.argv.includes('--crash-probe')) crashProbe().catch(error => { console.error(error); process.exitCode = 1; });
