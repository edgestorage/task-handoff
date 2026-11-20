const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { files } = require('./history-retention-parity.js');
const { readonly, normalizer, projectSession, inline } = require('./attachment-commit-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { CodexAppServerSessionControl } = require('../../packages/ai-session-runtime/src/codex-app-server/session/control.ts');

async function observe(action, name) {
  const started = Date.now();
  let owner, registry, session, restore;
  const calls = [], warnings = [];
  const queued = name === 'C04';
  const accepted = name === 'C02' || (queued && action === 'accept');
  const busy = queued || action === 'steer';
  try {
    return await withAttachmentApp(async (app, root) => {
      await app.ready();
      const send = payload => app.inject({ method: 'POST', url: `/api/ai-sessions/${session.id}/messages`,
        headers: { 'x-task-handoff-trace-id': 'u039-trace' }, payload });
      let queueId;
      if (queued) {
        const response = await send({ message: 'Commit', mode: 'queue', attachments: [inline] });
        assert.equal(response.statusCode, 200);
        queueId = response.json().data.queueId;
        assert.ok(queueId);
      }
      let response;
      try {
        response = queued
          ? await app.inject({ method: 'POST', url: `/api/ai-sessions/${session.id}/queue/${queueId}/steer` })
          : await send({ message: 'Commit', mode: action === 'steer' ? 'steer' : 'auto', attachments: [inline] });
      } finally { restore?.(); restore = undefined; }
      assert.match(response.headers['content-type'], /^application\/json(?:; charset=utf-8)?$/);
      if (!queued) {
        assert.match(response.headers['server-timing'], /^instance_action;dur=\d+\.\d$/);
        assert.equal(response.headers['x-task-handoff-trace-id'], 'u039-trace');
      }
      const manifest = [...owner.manifests.values()][0];
      assert.ok(manifest);
      const project = () => {
        const value = projectSession(registry, session.id);
        return { ...value, activeTurnId: value.activeTurnId ?? null, userPrompt: value.userPrompt ?? null };
      };
      const capture = () => ({
        files: Object.fromEntries(Object.entries(files(root)).filter(([key]) => key.startsWith('ai-session-attachments/'))),
        attachments: owner.attachmentsForMessage(session.id, manifest.messageId),
      });
      const output = {
        response: { status: response.statusCode, contentType: 'application/json', body: response.json(),
          traceId: response.headers['x-task-handoff-trace-id'] ?? null, timed: !!response.headers['server-timing'] },
        calls, session: project(), after: capture(),
        queue: registry.get(session.id).queue.items.map(item => ({ status: item.status, attachments: item.attachments, error: item.error ?? null })),
      };
      // Preserve actual pre-fix HTTP output in the execution log. Do not turn
      // raw OS error text into the expected public contract by normalizing it.
      console.error(`U03.9 ${name}/${action} raw response: ${JSON.stringify(output.response)}`);
      output.retry = accepted
        ? owner.commitMessage(session.id, manifest.messageId, 'turn-commit')
        : owner.rollbackMessage(session.id, manifest.messageId);
      output.afterRetry = capture();
      assert.equal(calls.length, 1);
      if (output.response.body.error.code === 'AI_SESSION_ATTACHMENT_IO_FAILED') {
        assert.ok(warnings.some(warning => warning.includes('EACCES') && warning.includes('manifests')), 'retain raw OS diagnostics on the server');
      }
      const normalized = normalizer([[session.id, '<session>'], [manifest.messageId, '<message>'], [manifest.id, '<attachment>']])(output);
      // Only attachment creation/commit clocks vary. Each timestamp must be
      // bounded by this execution, and all disk copies must agree per field.
      const times = new Map();
      const normalizeTimes = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'createdAt' || key === 'committedAt') {
            assert.ok(Date.parse(child) >= started && Date.parse(child) <= Date.now());
            if (times.has(key)) assert.equal(child, times.get(key)); else times.set(key, child);
            value[key] = `<${key}>`;
          } else normalizeTimes(child);
        }
      };
      normalizeTimes(normalized);
      return normalized;
    }, root => {
      owner = new AiSessionConversationAttachmentStore({ dataDir: root }, { onWarning: warning => warnings.push(warning) });
      registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions'), conversationAttachments: owner });
      session = registry.applyAdapterSnapshot({ source: 'control', agent: 'codex', creationSource: 'ai-session',
        providerSessionId: 'thread-commit', cwd: root, status: busy ? 'running' : 'idle', phase: busy ? 'thinking' : 'unknown',
        ...(busy ? { activeTurnId: 'turn-commit' } : {}) });
      const attempt = async (thread, message, inputs) => {
        const image = inputs.find(input => input.type === 'localImage');
        assert.ok(image);
        calls.push({ action: busy ? 'steer' : 'start', providerSessionId: thread, message,
          contentHex: fs.readFileSync(image.path).toString('hex') });
        if (accepted || name === 'C03') restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
        if (accepted) return { turnId: 'turn-commit' };
        throw Object.assign(new Error('provider rejected'), { code: 'PROVIDER_REJECTED', statusCode: 503 });
      };
      const control = new CodexAppServerSessionControl({ registry, readyThreadClient: async () => ({
        startTurn: attempt, steerTurn: (thread, turn, message, inputs) => attempt(thread, message, inputs),
      }) });
      return { aiSessionRegistry: registry, codexAppServer: {
        id: 'http-parity', agent: 'codex', refresh() {}, stop() {}, async ensureReady() {},
        supportsThreadSettingsUpdate: () => true, supportsProviderReload: () => false,
        startMessage: control.startMessage.bind(control), steerMessage: control.steerMessage.bind(control),
      } };
    });
  } finally { restore?.(); }
}

async function observeAttachmentControlHttp(name) {
  const variants = name === 'C04' ? ['reject', 'accept'] : ['start', 'steer'];
  const output = {};
  for (const action of variants) output[action] = await observe(action, name);
  return output;
}
module.exports = { observeAttachmentControlHttp };
