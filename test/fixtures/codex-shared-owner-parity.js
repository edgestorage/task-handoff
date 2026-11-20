const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ts = require('typescript');
const { registerWorkspaceRequire } = require('../workspace-require.js');
registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { AppRuntimeManager } = require('../../packages/app-runtime/src/runtime.ts');
const { codexAppServerSocketPath } = require('../../packages/app-runtime/src/runtime-utils.ts');
const { builtinManagedAppDefinition } = require('../../packages/app-runtime/src/managed-app-definitions/registry.ts');
const { managedAppLauncherPath } = require('../../packages/app-runtime/src/managed-node-apps.ts');
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
async function until(predicate, reason) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, reason);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function greeting(socketPath) {
  return await new Promise((resolve, reject) => {
    const client = net.connect(socketPath); let text = '';
    client.on('connect', () => client.write('greet\n'));
    client.setTimeout(2000, () => client.destroy(new Error('greeting timeout')));
    client.on('data', bytes => { text += bytes; });
    client.on('error', reject); client.on('end', () => resolve(text));
  });
}
async function observeSharedOwner(name) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codex-owner-parity-'));
  const paths = { dataDir: root, runtimeDir: path.join(root, 'runtime'), logDir: path.join(root, 'logs'),
    appCatalogDir: path.join(root, 'app-catalog'), appSessionsDir: path.join(root, 'app-sessions') };
  const command = managedAppLauncherPath(path.join(root, 'managed-apps'), builtinManagedAppDefinition('codex'));
  assert.ok(command, 'managed Codex launcher');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'codex-shared-owner/fake-codex.py'), command); fs.chmodSync(command, 0o755);
  const runtime = new AppRuntimeManager(paths);
  const socket = codexAppServerSocketPath(path.join(paths.runtimeDir, 'codex-app-server'));
  const records = () => fs.existsSync(path.join(root, 'launches.jsonl'))
    ? fs.readFileSync(path.join(root, 'launches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const environment = (mode, marker) => ({ OWNER_PARITY_ROOT: root, OWNER_PARITY_MODE: mode, OWNER_PARITY_MARKER: marker });
  // Story MCP args are derived from the ambient environment. Keep this fixture
  // deterministic so the shared golden does not depend on the invoking shell.
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.TASK_HANDOFF_AGENT_TOOLS_ENDPOINT;
  delete baseEnvironment.TASK_HANDOFF_AGENT_TOOLS_TOKEN;
  const acquire = id => runtime.acquireSharedResource('codex', command, root, baseEnvironment, id);
  const release = id => runtime.releaseSharedResource('codex', id);
  const snapshot = () => ({ owner: runtime.sharedResourceInfo('codex')?.details ?? null, socketExists: fs.existsSync(socket),
    launches: records(), processes: records().map(record => ({ pid: record.pid, alive: alive(record.pid), groupAlive: alive(-record.pid) })) });
  const stopped = () => until(() => records().every(record => !alive(-record.pid)), 'owned groups must exit');
  const output = {};
  try {
    runtime.replaceSharedResourcePrivateEnvironment('codex', environment(name === 'C02' ? 'exit' : 'ready', 'one'));
    if (name === 'C01') {
      fs.mkdirSync(path.dirname(socket), { recursive: true }); fs.writeFileSync(socket, 'test-owned-stale-socket');
      output.first = acquire('consumer-a').details; output.duplicate = acquire('consumer-a').details; output.second = acquire('consumer-b').details;
      output.greeting = await greeting(socket); output.shared = snapshot();
      release('unknown'); output.unknownReleased = snapshot(); release('consumer-a'); output.oneReleased = snapshot();
      release('consumer-a'); output.repeatReleased = snapshot(); release('consumer-b'); await stopped(); output.lastReleased = snapshot();
    } else if (name === 'C02') {
      try { acquire('consumer-a'); assert.fail('early exit must fail'); } catch (error) {
        assert.equal(error.code, 'CODEX_APP_SERVER_START_FAILED'); assert.ok(error.message); output.error = { code: error.code };
        console.error('U05.1 startup error:', error.message);
      }
      await stopped(); output.failed = snapshot();
      runtime.replaceSharedResourcePrivateEnvironment('codex', environment('ready', 'two'));
      output.retry = acquire('consumer-a').details; output.greeting = await greeting(socket); output.recovered = snapshot();
      release('consumer-a'); await stopped(); output.released = snapshot();
    } else {
      output.first = acquire('consumer-a').details; output.greetingOne = await greeting(socket);
      runtime.replaceSharedResourcePrivateEnvironment('codex', environment('ready', 'two'));
      output.second = acquire('consumer-b').details; output.greetingTwo = await greeting(socket);
      await until(() => !alive(-records()[0].pid), 'previous group exits before observation');
      await new Promise(setImmediate); output.replaced = snapshot();
      release('consumer-a'); output.oldReleased = snapshot();
      release('consumer-b'); await stopped(); output.lastReleased = snapshot();
    }
    // Preserve PID identity, generation order, exact argv and private env markers.
    // Normalize only the fixture-owned launcher, root, and derived socket paths.
    const pids = new Map();
    records().forEach((record, index) => {
      pids.set(record.pid, `<child-${index + 1}>`);
      if (record.childPid !== null) pids.set(record.childPid, `<descendant-${index + 1}>`);
    });
    const walk = value => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, (key === 'pid' || key === 'childPid') && child !== null ? (assert.ok(pids.has(child)), pids.get(child)) : walk(child)]));
      if (typeof value === 'string') return value === command ? '<managed-codex>' : value.replaceAll(socket, '<socket>').replaceAll(root, '<root>');
      return value;
    };
    return walk(output);
  } catch (error) { console.error('owner harness failure', name, error); throw error; } finally {
    runtime.stopAll(); runtime.dispose();
    // These PIDs come only from this fixture's private CLI records.
    for (const record of records()) { if (alive(-record.pid)) { try { process.kill(-record.pid, 'SIGKILL'); } catch {} } }
    await stopped(); fs.rmSync(path.dirname(socket), { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  }
}
function assertSharedOwner(name, actual) {
  if (name === 'C01') {
    assert.deepEqual(actual.first, actual.duplicate); assert.deepEqual(actual.second, actual.first); assert.equal(actual.greeting, 'one');
    assert.deepEqual(actual.unknownReleased, actual.shared); assert.deepEqual(actual.oneReleased, actual.shared); assert.deepEqual(actual.repeatReleased, actual.shared);
    assert.equal(actual.lastReleased.owner, null); assert.equal(actual.lastReleased.socketExists, false); assert.equal(actual.lastReleased.processes[0].groupAlive, false);
  } else if (name === 'C02') {
    assert.equal(actual.failed.owner, null); assert.equal(actual.failed.socketExists, false); assert.equal(actual.failed.processes[0].groupAlive, false);
    assert.equal(actual.retry.pid, '<child-2>'); assert.equal(actual.greeting, 'two'); assert.equal(actual.released.owner, null);
  } else {
    assert.equal(actual.first.pid, '<child-1>'); assert.equal(actual.second.pid, '<child-2>'); assert.equal(actual.greetingOne, 'one'); assert.equal(actual.greetingTwo, 'two');
    assert.equal(actual.replaced.owner.pid, '<child-2>'); assert.deepEqual(actual.oldReleased, actual.replaced); assert.equal(actual.lastReleased.owner, null);
  }
}
module.exports = { observeSharedOwner, assertSharedOwner };
