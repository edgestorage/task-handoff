import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneInstanceDirectoryEntrySchema, ControlPlaneNodeDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';

import { createMobileAiSession, lifecycleGuidance, MobileAiSessionCreateRequestStore } from '../src/ai-sessions/session-lifecycle';
import type { ValueStore } from '../src/platform/secure-storage';
import { MobileAiSessionStore } from '../src/ai-sessions/store';
import { MobileDirectoryStore } from '../src/directories/store';
import { MobileDirectoryController } from '../src/directories/controller';
import { filterInstances } from '../src/directories/DirectoryLists';
import { aiSessionFolderOptions, canCreateSession, defaultAiSessionFolderId, initialInstanceId, INSTANCE_WORKSPACE_FOLDER_ID, instanceCreateGuidance } from '../src/ai-sessions/new-session-types';
import { appLaunchIssue, canLaunchApp, initialAppInstanceId } from '../src/app-sessions/new-app-session-types';
import { RESOURCE_NAME_MAX_LENGTH, validateResourceName } from '../src/instances/resource-name';

const instance = {
  ...ControlPlaneInstanceDirectoryEntrySchema.parse({
  id: 'instance-1', name: 'Instance', nodeId: 'node-1', status: 'running', health: 'ok', connectionStatus: 'online', ready: true,
  config: { defaultCodexPermissionMode: 'full-access' },
  capabilities: { aiSessionProviders: [{ agent: 'codex', actions: {}, permissionModes: ['ask', 'auto-review', 'full-access'], timeline: {} }] },
  observedAt: '2026-08-05T00:00:00.000Z', runtime: { id: 'runtime-1', name: 'Docker', type: 'docker' }, workspace: { status: 'ready', path: '/workspace' },
  protocol: { version: '2026-08-01', compatible: true }, aiSessions: { runningCount: 0, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: 0, updatedAt: '2026-08-05T00:00:00.000Z' },
  availableAgents: [{ id: 'codex', name: 'Codex', kind: 'tty', supportsCwdSelection: true }],
  }),
  availableApps: [{ id: 'terminal-tty', name: 'Terminal', kind: 'tty' as const, supportsCwdSelection: true }],
};

test('create owns stable idempotency identity and accepts created or already-created results', async () => {
  const create = jest.fn().mockResolvedValueOnce({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' })
    .mockResolvedValueOnce({ disposition: 'already-created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const input = { instance, agent: 'codex', cwdFolderId: 'folder-1', message: 'Build it', clientRequestId: 'mobile-request-1' };
  expect((await createMobileAiSession(api, input)).disposition).toBe('created');
  expect((await createMobileAiSession(api, input)).disposition).toBe('already-created');
  expect(create.mock.calls[0][1].clientRequestId).toBe(create.mock.calls[1][1].clientRequestId);
  expect(create.mock.calls[0][1].cwdFolderId).toBe('folder-1');
  expect(create.mock.calls[0][1].permissionMode).toBe('full-access');
});

test('new session selection honors a requested instance and exposes readiness guidance', () => {
  const offline = { ...instance, id: 'offline', name: 'Offline', ready: false, connectionStatus: 'offline' as const };
  expect(initialInstanceId([offline, instance], 'offline')).toBe('offline');
  expect(initialInstanceId([offline, instance])).toBe(instance.id);
  expect(canCreateSession(instance)).toBe(true);
  expect(canCreateSession(offline)).toBe(false);
  expect(instanceCreateGuidance(offline)).toMatch(/not ready/);
});

test('new session selects the instance project by authoritative folder id with a path fallback for older data', () => {
  const folders = [
    { id: 'folder-default', name: 'Default', path: '/workspace/default' },
    { id: 'folder-other', name: 'Other', path: '/workspace/other' },
  ];
  expect(defaultAiSessionFolderId(
    { type: 'local-folder', localFolderId: 'folder-default', path: '/stale/path' },
    '/workspace',
    folders,
  )).toBe('folder-default');
  expect(defaultAiSessionFolderId(
    { type: 'local-folder', path: '/workspace/other/' },
    '/workspace',
    folders,
  )).toBe('folder-other');
  expect(defaultAiSessionFolderId({ type: 'git-repository' }, '/workspace', folders)).toBe(INSTANCE_WORKSPACE_FOLDER_ID);
  expect(aiSessionFolderOptions({ type: 'git-repository' }, '/workspace', folders)).toEqual([
    { id: INSTANCE_WORKSPACE_FOLDER_ID, name: 'workspace', path: '/workspace' },
  ]);
});

test('create uses the instance runtime workspace without materializing a node folder id', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  await createMobileAiSession(api, { instance, agent: 'codex', message: 'Build it', clientRequestId: 'mobile-request-workspace' });
  expect(create.mock.calls[0][1].cwdFolderId).toBeUndefined();
});

test('directory exposes the authoritative default permission mode used by new sessions', () => {
  expect(instance.config.defaultCodexPermissionMode).toBe('full-access');
});

test('app launch selection uses the complete app inventory instead of the AI agent subset', () => {
  const offline = { ...instance, id: 'offline', ready: false, connectionStatus: 'offline' as const };
  expect(instance.availableApps[0].id).toBe('terminal-tty');
  expect(instance.availableAgents.some((agent) => agent.id === 'terminal-tty')).toBe(false);
  expect(initialAppInstanceId([offline, instance])).toBe(instance.id);
  expect(canLaunchApp(instance)).toBe(true);
  expect(appLaunchIssue(offline)).toBe('instance-not-ready');
});

test('create forwards the selected permission mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  await createMobileAiSession(api, { instance, agent: 'codex', cwdFolderId: 'folder-1', message: 'Build it', permissionMode: 'auto-review', clientRequestId: 'mobile-request-1' });
  expect(create.mock.calls[0][1].permissionMode).toBe('auto-review');
});

test('OpenCode creation forwards an advertised full-access permission mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const opencodeInstance = ControlPlaneInstanceDirectoryEntrySchema.parse({
    ...instance,
    availableAgents: [...instance.availableAgents, { id: 'opencode', name: 'OpenCode', kind: 'tty' as const, supportsCwdSelection: true }],
    capabilities: { aiSessionProviders: [{ agent: 'opencode', actions: {}, permissionModes: ['ask', 'auto-review', 'full-access'], timeline: {} }] },
  });
  await createMobileAiSession(api, { instance: opencodeInstance, agent: 'opencode', message: 'Build it', permissionMode: 'full-access', clientRequestId: 'mobile-opencode-request-1' });
  expect(create.mock.calls[0][1].permissionMode).toBe('full-access');
});

test('create forwards a preset action send mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  await createMobileAiSession(api, { instance, agent: 'codex', message: 'Build it', mode: 'queue', clientRequestId: 'story-action-1' });
  expect(create).toHaveBeenCalledWith(instance.id, expect.objectContaining({ mode: 'queue' }));
});

test('create forwards the selected model entity and model name', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const modelSelection = { modelEntityId: 'mdl-secondary', modelName: 'shared-name' };
  await createMobileAiSession(api, { instance, agent: 'codex', message: 'Build it', modelSelection, clientRequestId: 'mobile-request-model' });
  expect(create).toHaveBeenCalledWith(instance.id, expect.objectContaining({ modelSelection }));
});

test('create forwards staged attachment references', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const attachments = [{ id: 'upload-1', kind: 'image' as const, source: { type: 'upload-ref' as const } }];
  await createMobileAiSession(api, { instance, agent: 'codex', cwdFolderId: 'folder-1', message: 'Review it', attachments, clientRequestId: 'mobile-request-1' });
  expect(create.mock.calls[0][1].attachments).toEqual(attachments);
});

test('Claude creation does not receive the Codex permission mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const claudeInstance = { ...instance, availableAgents: [...instance.availableAgents, { id: 'claude', name: 'Claude', kind: 'tty' as const, supportsCwdSelection: true }] };
  await createMobileAiSession(api, { instance: claudeInstance, agent: 'claude', cwdFolderId: 'folder-1', message: 'Build it', permissionMode: 'full-access', clientRequestId: 'mobile-request-1' });
  expect(create.mock.calls[0][1].permissionMode).toBeUndefined();
});

test('create request identity survives a new store instance and changes only with the payload', async () => {
  const values = new Map<string, string>();
  const storage: ValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  const ids = ['request-1', 'request-2', 'request-3'];
  const createId = () => ids.shift()!;
  const payload = { agent: 'codex', cwdFolderId: 'folder-1', message: 'Build it', modelSelection: { modelEntityId: 'mdl-one', modelName: 'same-name' } };
  const first = new MobileAiSessionCreateRequestStore(storage);
  expect(await first.getOrCreate('cp', 'instance', payload, createId)).toBe('request-1');
  const afterRestart = new MobileAiSessionCreateRequestStore(storage);
  expect(await afterRestart.getOrCreate('cp', 'instance', payload, createId)).toBe('request-1');
  expect(await afterRestart.getOrCreate('cp', 'instance', { ...payload, message: 'Build something else' }, createId)).toBe('request-2');
  await afterRestart.clear('cp', 'instance', 'request-2');
  expect(await afterRestart.getOrCreate('cp', 'instance', { ...payload, modelSelection: { modelEntityId: 'mdl-two', modelName: 'same-name' }, message: 'Build something else' }, createId)).toBe('request-3');
});

test('directory and Inbox state remain isolated across Control Planes and data sources', () => {
  const directories = new MobileDirectoryStore();
  const sessions = new MobileAiSessionStore();
  directories.set('cp-a', { instances: [instance], phase: 'ready' });
  directories.set('cp-b', { instances: [{ ...instance, id: 'instance-b' }], phase: 'ready' });
  sessions.setScope('cp-a', { kind: 'instance', instanceId: 'instance-1' });
  sessions.setScope('cp-b', { kind: 'instance', instanceId: 'instance-b' });
  sessions.setSyncState('cp-a', { phase: 'offline' });
  expect(directories.profile('cp-a').instances[0].connectionStatus).toBe('online');
  expect(directories.profile('cp-b').instances[0].id).toBe('instance-b');
  expect(sessions.profile('cp-a').scope).toEqual({ kind: 'instance', instanceId: 'instance-1' });
  expect(sessions.profile('cp-b').scope).toEqual({ kind: 'instance', instanceId: 'instance-b' });
});

test('instance subscribers ignore node-only directory updates', () => {
  const directories = new MobileDirectoryStore();
  const listener = jest.fn();
  directories.set('cp-a', { instances: [instance], phase: 'ready' });
  directories.subscribeInstances('cp-a', listener);

  directories.set('cp-a', { phase: 'stale' });
  expect(listener).not.toHaveBeenCalled();
  directories.setInstanceName('cp-a', instance.id, 'Renamed');
  expect(listener).toHaveBeenCalledTimes(1);
});

test('offline and provider errors include a desktop remediation path', () => {
  expect(lifecycleGuidance({ code: 'INSTANCE_OFFLINE', message: 'Offline' }).message).toMatch(/desktop app/);
  expect(lifecycleGuidance({ code: 'PROVIDER_UNAVAILABLE', message: 'Missing key' }).message).toMatch(/desktop app/);
});

test('directory controller marks cache offline and refreshes authoritative snapshots on resume', async () => {
  const store = new MobileDirectoryStore();
  const updated = { ...instance, status: 'stopped' as const, connectionStatus: 'offline' as const };
  const nodes = jest.fn().mockResolvedValue([]);
  const instanceBoard = jest.fn().mockResolvedValueOnce([instance]).mockResolvedValueOnce([updated]);
  const api = { resources: { nodes, instanceBoard } } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-a', api, store);
  await controller.start();
  expect(store.profile('cp-a').instances[0].status).toBe('running');
  controller.offline();
  expect(store.profile('cp-a').phase).toBe('offline');
  expect(store.profile('cp-a').instances[0].status).toBe('running');
  await controller.start();
  expect(store.profile('cp-a').phase).toBe('ready');
  expect(store.profile('cp-a').instances[0].status).toBe('stopped');
  expect(instanceBoard).toHaveBeenCalledTimes(2);
});

test('directory controller explicitly refreshes nodes and instances as one authoritative snapshot', async () => {
  const store = new MobileDirectoryStore();
  const updated = { ...instance, status: 'stopped' as const, connectionStatus: 'offline' as const };
  const nodes = jest.fn().mockResolvedValue([]);
  const instanceBoard = jest.fn().mockResolvedValueOnce([instance]).mockResolvedValueOnce([updated]);
  const api = { resources: { nodes, instanceBoard } } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-refresh', api, store);

  await controller.start();
  await controller.refresh();

  expect(nodes).toHaveBeenCalledTimes(2);
  expect(instanceBoard).toHaveBeenCalledTimes(2);
  expect(store.profile('cp-refresh').instances[0].status).toBe('stopped');
});

test('directory controller applies node connection and instance lifecycle events before its recovery snapshot', async () => {
  const store = new MobileDirectoryStore();
  const node = ControlPlaneNodeDirectoryEntrySchema.parse({
    id: 'node-1', name: 'Node', status: 'online', health: 'ok', connectionMode: 'reverse-wss',
    observedAt: '2026-08-05T00:00:00.000Z', capabilities: [],
  });
  const running = { ...instance, availableActions: ['stop', 'restart'] as const };
  let handlers: { onEvent(event: unknown): void } | undefined;
  const api = { resources: { nodes: jest.fn().mockResolvedValue([node]), instanceBoard: jest.fn().mockResolvedValue([running]) } } as unknown as ControlPlaneClient;
  const transport = {
    revalidate: jest.fn().mockResolvedValue(undefined),
    connectEvents: jest.fn((next) => { handlers = next; return { close: jest.fn() }; }),
  } as never;
  const controller = new MobileDirectoryController('cp-a', api, store, transport);
  await controller.start();

  handlers!.onEvent({
    type: 'node.connection.updated', topic: 'node.state', scope: { nodeId: node.id },
    payload: { nodeId: node.id, phase: 'reconnecting', changedAt: '2026-08-05T00:00:02.000Z' },
  });
  expect(store.profile('cp-a').nodes[0].connectionPhase).toBe('reconnecting');
  handlers!.onEvent({
    type: 'node.connection.updated', topic: 'node.state', scope: { nodeId: node.id },
    payload: { nodeId: node.id, phase: 'healthy', changedAt: '2026-08-05T00:00:01.000Z' },
  });
  expect(store.profile('cp-a').nodes[0].connectionPhase).toBe('reconnecting');

  handlers!.onEvent({
    type: 'instance.lifecycle.snapshot', topic: 'instances', scope: { instanceId: instance.id },
    payload: {
      instanceId: instance.id, revision: 2, updatedAt: '2026-08-05T00:00:03.000Z',
      status: 'stopping', health: 'ok', connectionStatus: 'online', ready: false,
    },
  });
  expect(store.profile('cp-a').instances[0].status).toBe('stopping');
  expect(store.profile('cp-a').instances[0].availableActions).toEqual([]);
  controller.stop();
});

test('directory controller applies complete node connection projections to replace stale health', () => {
  const store = new MobileDirectoryStore();
  const failedNode = ControlPlaneNodeDirectoryEntrySchema.parse({
    id: 'node-stale', name: 'Node', status: 'offline', health: 'failed', connectionMode: 'reverse-wss',
    connectionPhase: 'offline', observedAt: '2026-08-05T00:00:00.000Z', capabilities: [],
  });
  store.set('cp-stale', { nodes: [failedNode], phase: 'ready' });
  const controller = new MobileDirectoryController('cp-stale', { resources: {} } as unknown as ControlPlaneClient, store);

  expect(controller.applyEvent({
    type: 'node.connection.updated', topic: 'node.state', scope: { nodeId: failedNode.id },
    payload: {
      nodeId: failedNode.id, phase: 'healthy', status: 'online', health: 'ok',
      changedAt: '2026-08-05T00:00:02.000Z', lastSeenAt: '2026-08-05T00:00:02.000Z',
    },
  })).toBe(true);
  expect(store.profile('cp-stale').nodes[0]).toMatchObject({ status: 'online', health: 'ok', connectionPhase: 'healthy' });
  controller.stop();
});

test('directory controller keeps the newest per-node fleet state', () => {
  const store = new MobileDirectoryStore();
  store.set('cp-fleet', {
    nodeStates: [{ nodeId: 'node-1', resource: 'instances', phase: 'loading', revision: 2 }],
  });
  const api = { resources: {} } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-fleet', api, store);

  expect(controller.applyEvent({
    type: 'node.fleet.updated', topic: 'instances', scope: { nodeId: 'node-1' },
    payload: { nodeId: 'node-1', resource: 'instances', phase: 'stale', revision: 1 },
  })).toBe(false);
  expect(store.profile('cp-fleet').nodeStates[0].phase).toBe('loading');
  expect(controller.applyEvent({
    type: 'node.fleet.updated', topic: 'instances', scope: { nodeId: 'node-1' },
    payload: { nodeId: 'node-1', resource: 'instances', phase: 'ready', revision: 3, updatedAt: '2026-08-22T00:00:00.000Z', contentChanged: false },
  })).toBe(true);
  expect(store.profile('cp-fleet').nodeStates[0].phase).toBe('ready');
  controller.stop();
});

test('fleet diagnostics stay local while semantic changes refresh only instances', async () => {
  jest.useFakeTimers();
  try {
    const store = new MobileDirectoryStore();
    store.set('cp-fleet-targeted', { instances: [instance], phase: 'ready' });
    const nodes = jest.fn().mockResolvedValue([]);
    const instanceBoard = jest.fn().mockResolvedValue([instance]);
    const api = { resources: { nodes, instanceBoard } } as unknown as ControlPlaneClient;
    const controller = new MobileDirectoryController('cp-fleet-targeted', api, store);

    controller.applyEvent({
      type: 'node.fleet.updated', topic: 'instances', scope: { nodeId: 'node-1' },
      payload: { nodeId: 'node-1', resource: 'instances', phase: 'ready', revision: 1, contentChanged: false },
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(nodes).not.toHaveBeenCalled();
    expect(instanceBoard).not.toHaveBeenCalled();

    controller.applyEvent({
      type: 'node.fleet.updated', topic: 'instances', scope: { nodeId: 'node-1' },
      payload: { nodeId: 'node-1', resource: 'instances', phase: 'ready', revision: 2, contentChanged: true },
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(nodes).not.toHaveBeenCalled();
    expect(instanceBoard).toHaveBeenCalledTimes(1);

    controller.applyEvent({
      type: 'node.fleet.updated', topic: 'instances', scope: { nodeId: 'node-1' },
      payload: { nodeId: 'node-1', resource: 'instances', phase: 'ready', revision: 3 },
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(instanceBoard).toHaveBeenCalledTimes(2);

    controller.applyEvent({
      type: 'instance.ai-session.message.accepted', topic: 'instances', scope: { instanceId: instance.id }, payload: {},
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(instanceBoard).toHaveBeenCalledTimes(2);
    controller.stop();
  } finally {
    jest.useRealTimers();
  }
});

test('instance lifecycle actions use the server-projected availability and refresh the directory', async () => {
  const store = new MobileDirectoryStore();
  const running = ControlPlaneInstanceDirectoryEntrySchema.parse({ ...instance, availableActions: ['stop', 'restart'] });
  const stopped = ControlPlaneInstanceDirectoryEntrySchema.parse({
    ...instance,
    status: 'stopped',
    connectionStatus: 'offline',
    ready: false,
    availableActions: ['start'],
  });
  store.set('cp-a', { instances: [running], phase: 'ready' });
  const instanceAction = jest.fn().mockResolvedValue({ id: instance.id, status: 'stopping' });
  const api = { resources: { instanceAction, nodes: jest.fn().mockResolvedValue([]), instanceBoard: jest.fn().mockResolvedValue([stopped]) } } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-a', api, store);

  await controller.runInstanceAction(instance.id, 'stop');
  expect(instanceAction).toHaveBeenCalledWith(instance.id, 'stop');
  expect(store.profile('cp-a').instances[0].availableActions).toEqual(['start']);
  await expect(controller.runInstanceAction(instance.id, 'restart')).rejects.toThrow(/not currently available/);
});

test('directory renames use shared resource APIs and immediately update the authoritative cache projection', async () => {
  const store = new MobileDirectoryStore();
  const node = ControlPlaneNodeDirectoryEntrySchema.parse({
    id: 'node-1', name: 'Node', status: 'online', health: 'ok', connectionMode: 'direct-http',
    observedAt: '2026-08-05T00:00:00.000Z', capabilities: [],
  });
  store.set('cp-a', { nodes: [node], instances: [instance], phase: 'ready' });
  const updateNodeName = jest.fn().mockResolvedValue({ id: node.id, name: 'Renamed Node' });
  const updateInstanceName = jest.fn().mockResolvedValue({ id: instance.id, name: 'Renamed Instance' });
  const api = {
    resources: {
      nodes: jest.fn().mockResolvedValue([{ ...node, name: 'Renamed Node' }]),
      instanceBoard: jest.fn().mockResolvedValue([{ ...instance, name: 'Renamed Instance' }]),
      updateNodeName,
      updateInstanceName,
    },
  } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-a', api, store);

  await controller.updateNodeName(node.id, 'Renamed Node');
  expect(store.profile('cp-a').nodes[0].name).toBe('Renamed Node');
  expect(updateNodeName).toHaveBeenCalledWith(node.id, 'Renamed Node');

  await controller.updateInstanceName(instance.id, 'Renamed Instance');
  expect(store.profile('cp-a').instances[0].name).toBe('Renamed Instance');
  expect(updateInstanceName).toHaveBeenCalledWith(instance.id, 'Renamed Instance');
});

test('concurrent instance mutations refresh only instances and queue one trailing refresh', async () => {
  const store = new MobileDirectoryStore();
  store.set('cp-a', { instances: [instance], phase: 'ready' });
  let resolveInstances!: (value: typeof instance[]) => void;
  const nodes = jest.fn().mockResolvedValue([]);
  const instanceBoard = jest.fn()
    .mockReturnValueOnce(new Promise<typeof instance[]>((resolve) => { resolveInstances = resolve; }))
    .mockResolvedValueOnce([instance]);
  const api = {
    resources: {
      nodes,
      instanceBoard,
      updateInstanceName: jest.fn()
        .mockResolvedValueOnce({ id: instance.id, name: 'First' })
        .mockResolvedValueOnce({ id: instance.id, name: 'Second' }),
    },
  } as unknown as ControlPlaneClient;
  const controller = new MobileDirectoryController('cp-a', api, store);

  await Promise.all([
    controller.updateInstanceName(instance.id, 'First'),
    controller.updateInstanceName(instance.id, 'Second'),
  ]);
  expect(nodes).not.toHaveBeenCalled();
  expect(instanceBoard).toHaveBeenCalledTimes(1);

  resolveInstances([instance]);
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  expect(nodes).not.toHaveBeenCalled();
  expect(instanceBoard).toHaveBeenCalledTimes(2);
  controller.stop();
});

test('resource name validation matches the server name invariant', () => {
  expect(validateResourceName('   ', 'Current')).toBe('required');
  expect(validateResourceName('x'.repeat(RESOURCE_NAME_MAX_LENGTH + 1), 'Current')).toBe('too-long');
  expect(validateResourceName('  Current  ', 'Current')).toBe('unchanged');
  expect(validateResourceName('  Renamed  ', 'Current')).toBeUndefined();
});

test('instance directory filters by Node, authoritative status, and AI activity independently', () => {
  const problem = { ...instance, id: 'problem', nodeId: 'node-2', status: 'failed' as const, aiSessions: { ...instance.aiSessions, problemCount: 1 } };
  const idle = { ...instance, id: 'idle', nodeId: 'node-2', aiSessions: { ...instance.aiSessions } };
  const active = { ...instance, id: 'active', nodeId: 'node-1', aiSessions: { ...instance.aiSessions, runningCount: 1 } };
  expect(filterInstances([problem, idle, active], { nodeId: 'node-2', status: 'failed', ai: 'problem' }).map((item) => item.id)).toEqual(['problem']);
  expect(filterInstances([problem, idle, active], { ai: 'active' }).map((item) => item.id)).toEqual(['active']);
  expect(filterInstances([problem, idle, active], { ai: 'idle' }).map((item) => item.id)).toEqual(['idle']);
});
