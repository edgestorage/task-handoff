const { project, replace } = require('./opencode-interaction-parity.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { mock } = require('node:test');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { AiSessionController } = require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const { ClaudeControlSockSessionBridge } = require('../../packages/ai-session-runtime/src/claude-control-sock.ts');
const { callClaudeControl, replyClaudeDaemonJob, killClaudeDaemonJob, subscribeClaudeDaemonJob } = require('../../packages/core/src/core/claude-control-sock.ts');
const fixturePath = path.resolve(__dirname, '../../controlled-instance-rs/crates/instance/tests/fixtures/claude-interaction-parity.json');
const SESSION = 'ses_0000000000001';
// Same explicit turn/body projection as OpenCode. Claude additionally observes
// app binding, provider diagnostic metadata and action availability. Generated
// local turn/message IDs map bijectively; all fixed upstream IDs remain exact.
function state(session) { return { ...project(session), ...Object.fromEntries(['agent', 'creationSource', 'appId', 'appSessionId', 'appBindingKeys', 'providerMeta', 'actions'].map(k => [k, session[k] ?? null])) }; }
function normalize(actual, cwd, socket) {
    let turns = [], messages = [];
    const scan = value => {
        if (!value || typeof value !== 'object')
            return;
        if (Array.isArray(value)) {
            value.forEach(scan);
            return;
        }
        if (value.activeTurnId && !value.activeTurnId.startsWith('existing-') && !turns.includes(value.activeTurnId))
            turns.push(value.activeTurnId);
        for (const turn of value.turns || []) {
            if (!turn.id.startsWith('existing-') && !turns.includes(turn.id))
                turns.push(turn.id);
            for (const m of turn.userMessages || [])
                if (!m.id.startsWith('existing-') && !messages.includes(m.id))
                    messages.push(m.id);
        }
        Object.values(value).forEach(scan);
    };
    scan(actual);
    turns.forEach((id, i) => actual = replace(actual, id, `$turn${i + 1}`));
    messages.forEach((id, i) => actual = replace(actual, id, `$message${i + 1}`));
    return JSON.parse(JSON.stringify(replace(replace(actual, cwd, '/workspace'), socket, '/control.sock')));
}
async function observe(scenario) {
    const root = fs.mkdtempSync('/tmp/ci-u047-'), cwd = path.join(root, 'workspace'), socket = path.join(root, 'c.sock');
    fs.mkdirSync(cwd);
    // The source transcript resolver defaults to os.homedir(), rather than
    // CLAUDE_HOME. This test file runs scenarios serially in its own test process.
    const homedir = mock.method(os, 'homedir', () => root);
    let bridge, stop, wake = () => { }, subscriber, replies = 0, received = 0;
    const sockets = new Set(), requests = [], results = [], checkpoints = [];
    const seed = replace(replace(scenario.seed, '/workspace', cwd), '/control.sock', socket);
    const job = { short: 'a1b2c3d4', sessionId: 'provider-u047', cwd, state: seed.status === 'running' ? 'running' : 'idle', ...(seed.status === 'running' ? { detail: 'working' } : {}) };
    const server = net.createServer(peer => {
        sockets.add(peer);
        peer.on('close', () => sockets.delete(peer));
        let buffer = '';
        peer.setEncoding('utf8');
        peer.on('data', chunk => {
            buffer += chunk;
            const n = buffer.indexOf('\n');
            if (n < 0)
                return;
            const request = JSON.parse(buffer.slice(0, n));
            buffer = buffer.slice(n + 1);
            requests.push(request);
            assert.equal(request.proto, 1);
            if (request.op === 'list') {
                peer.end(JSON.stringify({ ok: true, jobs: [job] }) + '\n');
            }
            else if (request.op === 'subscribe') {
                assert.equal(request.short, 'a1b2c3d4');
                subscriber = peer;
                wake();
            }
            else {
                assert.equal(request.op, 'reply');
                assert.equal(request.short, 'a1b2c3d4');
                replies++;
                peer.end(JSON.stringify(scenario.rejectFirst && replies === 1 ? { ok: false, code: 'EBUSY', error: 'fixture reply rejected' } : { ok: true }) + '\n');
            }
        });
    });
    try {
        await new Promise(resolve => server.listen(socket, resolve));
        const registry = createAiSessionRegistry({ dir: path.join(root, 'sessions') });
        registry.restoreAuthority(seed);
        const wait = async (predicate, label) => { if (predicate())
            return; let timer; try {
            await Promise.race([new Promise(resolve => { wake = () => { if (predicate())
                    resolve(); }; }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`U04.7 ${label} timeout`)), 5000); })]);
        }
        finally {
            clearTimeout(timer);
            wake = () => { };
        } };
        bridge = new ClaudeControlSockSessionBridge(registry, {
            list: () => callClaudeControl({ op: 'list' }, { sockPath: socket }), reply: replyClaudeDaemonJob, kill: killClaudeDaemonJob,
            subscribe: (short, input) => subscribeClaudeDaemonJob(short, { ...input, onMessage: message => { input.onMessage(message); received++; wake(); } }),
        });
        stop = registry.onChange(() => wake());
        const controller = new AiSessionController(registry);
        controller.register(bridge);
        const app = { ...scenario.app, ai: { claude: { short: 'a1b2c3d4', controlSock: socket } }, launch: { cwd } };
        await bridge.refresh({ registry, appSessions: [app] });
        await wait(() => !!subscriber, 'subscribe');
        const capture = name => checkpoints.push({ name, session: state(registry.get(SESSION)) });
        capture('initial');
        if (scenario.send) {
            if (scenario.rejectFirst) {
                const before = JSON.parse(JSON.stringify(registry.get(SESSION)));
                await assert.rejects(() => controller.sendMessage(SESSION, { message: ' Hello 世界 ', clientRequestId: 'rejected-u047' }), error => { results.push({ name: 'rejected', error: { code: error.code, message: error.message, statusCode: error.statusCode } }); return true; });
                assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))), before, 'rejected reply preserves full owner');
                capture('rejected');
            }
            const ack = await controller.sendMessage(SESSION, { message: ' Hello 世界 ', clientRequestId: 'accepted-u047' });
            results.push({ name: 'ack', provider: ack.provider, action: ack.action, turnId: ack.turnId ?? null, providerTurnId: ack.providerTurnId ?? null, session: state(ack.session) });
            capture('ack');
        }
        for (const [index, step] of scenario.steps.entries()) {
            const before = JSON.parse(JSON.stringify(registry.get(SESSION)));
            // CRLF/JSON frames exercise the real transport. Stream diagnostic
            // text is deliberately not an assistant response in this provider boundary.
            subscriber.write(JSON.stringify(step.message) + '\r\n');
            await wait(() => received === index + 1, step.name);
            if (step.unchanged)
                assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))), before, 'diagnostic stream cannot mutate owner');
            capture(step.name);
        }
        const reopened = createAiSessionRegistry({ dir: path.join(root, 'sessions') }).get(SESSION);
        assert.deepEqual(JSON.parse(JSON.stringify(reopened)), JSON.parse(JSON.stringify(registry.get(SESSION))), 'full owner reopens including clocks');
        return normalize({ requests, results, checkpoints, restored: state(reopened) }, cwd, socket);
    }
    finally {
        stop?.();
        bridge?.stop();
        for (const peer of sockets)
            peer.destroy();
        await new Promise(resolve => server.close(resolve));
        homedir.mock.restore();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
module.exports = { observe, fixturePath };
if (require.main === module)
    (async () => { const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); for (const s of fixture.scenarios) {
        s.expected = await observe(s);
        fs.writeFileSync(`/tmp/ci-u047-${s.id}-node.json`, JSON.stringify(s.expected, null, 2) + '\n');
        process.stderr.write(`${s.id} observed\n`);
    } fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n'); })().catch(e => { console.error(e); process.exitCode = 1; });
