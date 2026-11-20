const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { registerWorkspaceRequire } = require('../workspace-require.js');

registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppManagementManager } = require('../../packages/controlled-instance/src/web/app-management.ts');
const { AppRecipeExecutionError } = require('../../packages/controlled-instance/src/web/app-recipe-executor.ts');

const capabilities = { platform: 'linux', arch: 'x64', installers: ['apt'], privilege: 'root' };
const app = {
  launcher: { id: 'tool', name: 'tool', kind: 'tty', command: 'bin/tool' },
  detection: [{ type: 'launcher-executable' }],
  distribution: {
    recipes: [{
      type: 'archive',
      platforms: ['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos'],
      privilege: 'user',
      url: 'https://example.invalid/tool.tar.gz',
      sha256: '0'.repeat(64),
      format: 'tar.gz',
      installRoot: 'tool',
    }],
  },
};

function jobProjection(job) {
  return {
    operation: job.operation,
    state: job.state,
    phase: job.phase ?? null,
    hasStartedAt: Boolean(job.startedAt),
    hasFinishedAt: Boolean(job.finishedAt),
    error: job.error ?? null,
  };
}

function appProjection(manager) {
  const app = manager.snapshot().apps[0];
  return {
    state: app.state,
    managementSource: app.managementSource,
    canInstall: app.canInstall,
    canUninstall: app.canUninstall,
    canUpdate: app.canUpdate,
    installReason: app.installReason?.code ?? null,
    uninstallReason: app.uninstallReason?.code ?? null,
    updateReason: app.updateReason?.code ?? null,
  };
}

function managerOptions(root, order, executions, terminal) {
  const stateDir = path.join(root, 'state');
  const installBaseDir = path.join(root, 'apps');
  const warnings = [];
  let installed = false;
  let terminalJob;
  let resolveTerminal;
  const notified = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    terminal.timeout = setTimeout(() => reject(new Error('terminal callback was not invoked')), 2_000);
    terminal.timeout.unref?.();
  });
  return {
    ...{ stateDir, installBaseDir },
    definitions: () => [app],
    capabilities: () => capabilities,
    detection: () => ({ state: installed ? 'installed' : 'not-installed', executablePaths: installed ? ['/bin/tool'] : [] }),
    managementSource: () => installed ? 'recipe' : 'none',
    sessions: () => [],
    warn: (message) => warnings.push(message),
    execute: async () => {
      executions.value += 1;
      order.push('execute');
      installed = true;
    },
    publish: (event) => {
      if (!event.job) return;
      order.push(`event:${event.job.state}`);
      if (!['queued', 'running'].includes(event.job.state)) terminal.eventStates.push(event.job.state);
    },
    onTerminal: async (job) => {
      terminalJob = job;
      order.push(`notify:${job.state}`);
      clearTimeout(terminal.timeout);
      resolveTerminal();
    },
    getState: () => ({ installed, stateDir, installBaseDir }),
    getTerminalJob: () => terminalJob,
    getWarnings: () => warnings,
    notified,
  };
}

async function observeTerminalLifecycle(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `app-terminal-parity-${name}-`));
  const order = [];
  const executions = { value: 0 };
  const terminal = { eventStates: [] };
  const options = managerOptions(root, order, executions, terminal);
  const { stateDir, installBaseDir } = options;
  const manager = new AppManagementManager({
    ...options,
    packageLifecycle: () => ({
      beforeChange: () => {
        order.push('drain');
        if (name === 'drain-failure' || name === 'rollback-failure') {
          throw new AppRecipeExecutionError('drain_failed', 'simulated drain failure', true);
        }
      },
      changed: (_operation, succeeded) => {
        order.push(`cleanup:${succeeded}`);
        if (name === 'cleanup-failure' || name === 'rollback-failure') {
          throw new AppRecipeExecutionError('cleanup_failed', 'simulated cleanup failure', false);
        }
      },
    }),
  });
  try {
    const queued = manager.request('tool', 'install');
    await manager.waitForIdle();
    await options.notified;
    const terminalJob = options.getTerminalJob();
    assert.equal(terminalJob.id, queued.id);
    assert.equal(manager.getJob(queued.id).state, terminalJob.state);
    const reopened = new AppManagementManager({
      stateDir,
      installBaseDir,
      definitions: () => [app],
      capabilities: () => capabilities,
      detection: options.detection,
      managementSource: options.managementSource,
      sessions: () => [],
      execute: async () => assert.fail('reopening must not execute package work'),
    });
    await reopened.refreshSnapshot();
    return {
      name,
      job: jobProjection(terminalJob),
      app: appProjection(manager),
      order,
      eventStates: terminal.eventStates,
      executions: executions.value,
      warnings: options.getWarnings(),
      reopened: {
        job: jobProjection(reopened.getJob(queued.id)),
        app: appProjection(reopened),
      },
    };
  } finally {
    clearTimeout(terminal.timeout);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { observeTerminalLifecycle };
