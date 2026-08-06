import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneInstanceDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';

import { createMobileAiSession, lifecycleGuidance, MobileAiSessionCreateRequestStore, runtimePathForInstance } from '../src/ai-sessions/session-lifecycle';
import type { ValueStore } from '../src/platform/secure-storage';
import { MobileAiSessionStore } from '../src/ai-sessions/store';
import { MobileDirectoryStore } from '../src/directories/store';
import { MobileDirectoryController } from '../src/directories/controller';
import { filterInstances } from '../src/directories/DirectoryLists';
import { canCreateSession, initialInstanceId, instanceCreateGuidance } from '../src/ai-sessions/new-session-types';

const instance = ControlPlaneInstanceDirectoryEntrySchema.parse({
  id: 'instance-1', name: 'Instance', nodeId: 'node-1', status: 'running', health: 'ok', connectionStatus: 'online', ready: true,
  config: { defaultCodexPermissionMode: 'full-access' },
  observedAt: '2026-08-05T00:00:00.000Z', runtime: { id: 'runtime-1', name: 'Docker', type: 'docker' }, workspace: { status: 'ready', path: '/workspace' },
  protocol: { version: '2026-08-01', compatible: true }, aiSessions: { runningCount: 0, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: 0, updatedAt: '2026-08-05T00:00:00.000Z' },
  availableAgents: [{ id: 'codex', name: 'Codex', kind: 'tty', supportsCwdSelection: true }],
});

test('runtime paths are absolute, instance-scoped, and never device URIs', () => {
  expect(runtimePathForInstance('/workspace/project', instance)).toEqual({ type: 'runtime-path', path: '/workspace/project' });
  expect(() => runtimePathForInstance('file:///device/photo', instance)).toThrow(/Device URIs/);
  expect(() => runtimePathForInstance('/Users/node-host/project', instance)).toThrow(/workspace reported/);
  expect(() => runtimePathForInstance('/workspace/../secret', instance)).toThrow(/traverse/);
});

test('create owns stable idempotency identity and accepts created or already-created results', async () => {
  const create = jest.fn().mockResolvedValueOnce({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' })
    .mockResolvedValueOnce({ disposition: 'already-created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const input = { instance, agent: 'codex', cwd: '/workspace/project', message: 'Build it', clientRequestId: 'mobile-request-1' };
  expect((await createMobileAiSession(api, input)).disposition).toBe('created');
  expect((await createMobileAiSession(api, input)).disposition).toBe('already-created');
  expect(create.mock.calls[0][1].clientRequestId).toBe(create.mock.calls[1][1].clientRequestId);
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

test('directory exposes the authoritative default permission mode used by new sessions', () => {
  expect(instance.config.defaultCodexPermissionMode).toBe('full-access');
});

test('create forwards the selected permission mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  await createMobileAiSession(api, { instance, agent: 'codex', cwd: '/workspace', message: 'Build it', permissionMode: 'auto-review', clientRequestId: 'mobile-request-1' });
  expect(create.mock.calls[0][1].permissionMode).toBe('auto-review');
});

test('Claude creation does not receive the Codex permission mode', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1', providerSessionId: 'provider-1', creationSource: 'ai-session' });
  const api = { aiSessions: { create } } as unknown as ControlPlaneClient;
  const claudeInstance = { ...instance, availableAgents: [...instance.availableAgents, { id: 'claude', name: 'Claude', kind: 'tty' as const, supportsCwdSelection: true }] };
  await createMobileAiSession(api, { instance: claudeInstance, agent: 'claude', cwd: '/workspace', message: 'Build it', permissionMode: 'full-access', clientRequestId: 'mobile-request-1' });
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
  const payload = { agent: 'codex', cwd: '/workspace', message: 'Build it' };
  const first = new MobileAiSessionCreateRequestStore(storage);
  expect(await first.getOrCreate('cp', 'instance', payload, createId)).toBe('request-1');
  const afterRestart = new MobileAiSessionCreateRequestStore(storage);
  expect(await afterRestart.getOrCreate('cp', 'instance', payload, createId)).toBe('request-1');
  expect(await afterRestart.getOrCreate('cp', 'instance', { ...payload, message: 'Build something else' }, createId)).toBe('request-2');
  await afterRestart.clear('cp', 'instance', 'request-2');
  expect(await afterRestart.getOrCreate('cp', 'instance', { ...payload, message: 'Build something else' }, createId)).toBe('request-3');
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

test('instance directory filters by Node, authoritative status, and AI activity independently', () => {
  const problem = { ...instance, id: 'problem', nodeId: 'node-2', status: 'failed' as const, aiSessions: { ...instance.aiSessions, problemCount: 1 } };
  const idle = { ...instance, id: 'idle', nodeId: 'node-2', aiSessions: { ...instance.aiSessions } };
  const active = { ...instance, id: 'active', nodeId: 'node-1', aiSessions: { ...instance.aiSessions, runningCount: 1 } };
  expect(filterInstances([problem, idle, active], { nodeId: 'node-2', status: 'failed', ai: 'problem' }).map((item) => item.id)).toEqual(['problem']);
  expect(filterInstances([problem, idle, active], { ai: 'active' }).map((item) => item.id)).toEqual(['active']);
  expect(filterInstances([problem, idle, active], { ai: 'idle' }).map((item) => item.id)).toEqual(['idle']);
});
