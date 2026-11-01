import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { MobileApprovalCenterController } from '../src/approval-center/controller';
import { mobileMetrics } from '../src/observability/mobile-metrics';
import type { MobileAiSessionProfileState } from '../src/ai-sessions/store';

const now = '2026-10-31T00:10:00.000Z';
const fingerprint = `sha256:${'a'.repeat(43)}`;
const operationGeneration = 'approval_generation_a';

const aiSession = {
  id: 'ses_a',
  agent: 'codex',
  cwd: '/workspace',
  startedAt: now,
  updatedAt: now,
  status: 'waiting',
  phase: 'approval',
};

const story = {
  id: 'stry_a',
  ownerNodeId: 'nod_a',
  title: 'Story A',
  documents: [],
  actions: [],
  createdAt: now,
  updatedAt: now,
};

const storyDecision = {
  id: 'dec_a',
  storyId: 'stry_a',
  actionId: 'act_a',
  storyRunId: 'srun_a',
  sessionId: 'ses_a',
  turnId: 'trn_a',
  question: 'Continue?',
  options: [{ id: 'yes', label: 'Yes' }],
  allowFreeText: false,
  status: 'pending',
  revision: 1,
  createdAt: now,
  updatedAt: now,
};

const operationRequest = {
  id: 'apr_a',
  operation: 'instance.delete',
  targetId: 'ins_a',
  createdAt: now,
  expiresAt: '2026-10-31T01:10:00.000Z',
};

const deviceRequest = {
  source: 'control-plane-device',
  requestId: 'dtr_a',
  status: 'pending',
  reason: 'first-seen',
  device: { name: 'Phone', kind: 'mobile', platform: 'ios' },
  fingerprint,
  comparisonCode: 'AAAA-BBBB-CCCC-DDDD',
  bindingId: 'bind_a',
  accountId: 'acct_a',
  ownerAccountId: 'acct_a',
  accessMode: 'owner',
  cloudAccessRoleId: 'role_a',
  requestedAt: now,
  lastSeenAt: now,
  expiresAt: '2026-10-31T01:10:00.000Z',
  revision: 1,
};

const nodeRequest = {
  controlPlaneId: 'cp_a',
  fingerprint,
  comparisonCode: 'AAAA-BBBB-CCCC-DDDD',
  nodeHandle: 'node-a',
  bindingId: 'bind_a',
  bindingRevision: 1,
  access: { userId: 'usr_a', permissions: [], roleIds: [] },
  requestId: 'ntr_a',
  status: 'pending',
  reason: 'first-seen',
  requestedAt: now,
  lastSeenAt: now,
  expiresAt: '2026-10-31T01:10:00.000Z',
  revision: 1,
};

function aiState(): MobileAiSessionProfileState {
  return {
    controlPlaneId: 'cp_a',
    snapshot: {
      updatedAt: now,
      instances: [{
        instanceId: 'ins_a',
        streamId: 'stream-a',
        aiSessions: {
          runningCount: 0,
          waitingCount: 1,
          staleCount: 0,
          sessions: [aiSession],
          updatedAt: now,
        },
      }],
    },
    messages: {},
    sync: { phase: 'ready', lastSyncedAt: now },
  } as MobileAiSessionProfileState;
}

function directory(): any {
  return {
    nodes: [{
      id: 'nod_a', name: 'Node A', status: 'online', health: 'ok', observedAt: now,
    }],
    instances: [{
      id: 'ins_a',
      name: 'Instance A',
      capabilities: { aiSessionProviders: [{ agent: 'codex', actions: { approvalDecisions: ['allow', 'deny'] } }] },
    }],
  };
}

function client(overrides: Record<string, any> = {}) {
  return {
    aiSessions: {
      approval: jest.fn(async () => ({ action: 'approval' })),
    },
    stories: {
      list: jest.fn(async () => ({ stories: [story], unavailableNodeIds: [] })),
      listDecisions: jest.fn(async () => ({ decisions: [storyDecision] })),
      decideStory: jest.fn(async () => ({ ...storyDecision, status: 'decided', revision: 2 })),
    },
    resources: {
      node: jest.fn(async () => ({
        id: 'nod_a',
        name: 'Node A',
        capabilities: {
          agent: {
            capabilities: {
              controlPlaneTrust: true,
              stories: { agentToolCapabilities: { decisions: true } },
            },
          },
        },
      })),
    },
    approvals: {
      snapshot: jest.fn(async () => ({ generation: operationGeneration, revision: 1, requests: [operationRequest] })),
      decide: jest.fn(async () => ({ id: operationRequest.id, status: 'approved' })),
    },
    deviceTrust: {
      snapshot: jest.fn(async () => ({ revision: 1, requests: [deviceRequest], trustedDevices: [], roles: [{ roleId: 'role_a', name: 'Operator', status: 'active', isAdmin: false }] })),
      decide: jest.fn(async () => ({ revision: 2, requests: [], trustedDevices: [], roles: [] })),
    },
    nodeAdmin: {
      listControlPlaneTrust: jest.fn(async () => ({ nodeId: 'nod_a', requests: [nodeRequest], pins: [] })),
      decideControlPlaneTrust: jest.fn(async () => ({ nodeId: 'nod_a', requests: [], pins: [] })),
    },
    ...overrides,
  } as unknown as ControlPlaneClient;
}

function createController(api = client(), options: Partial<{
  aiSessions(): MobileAiSessionProfileState;
  supportsAiSessions: boolean;
  supportsStories: boolean;
  supportsNodes: boolean;
}> = {}) {
  return new MobileApprovalCenterController('cp_a', api, {
    aiSessions: options.aiSessions ?? aiState,
    directory,
    supportsAiSessions: options.supportsAiSessions ?? true,
    supportsStories: options.supportsStories ?? true,
    supportsNodes: options.supportsNodes ?? true,
  });
}

test('loads every authoritative source and keeps stable keys scoped to the Control Plane', async () => {
  const controller = createController();
  await controller.start(new AbortController().signal);

  const state = controller.snapshot();
  expect(state.items).toHaveLength(5);
  expect(new Set(state.items.map((item) => item.type))).toEqual(new Set([
    'ai-session-approval',
    'story-decision',
    'operation-approval',
    'device-trust',
    'node-control-plane-trust',
  ]));
  expect(state.items.every((item) => item.key.startsWith('cp_a:'))).toBe(true);
  expect(state.items.find((item) => item.type === 'device-trust')).toMatchObject({
    roles: [{ roleId: 'role_a', name: 'Operator', status: 'active' }],
  });
  expect(Object.values(state.sources).every((source) => source.health.phase === 'ready')).toBe(true);
  expect(state.items.find((item) => item.type === 'operation-approval')).toMatchObject({ targetName: 'Instance A' });
  expect(state.items.find((item) => item.type === 'node-control-plane-trust')).toMatchObject({ nodeName: 'Node A' });
});

test('offline nodes do not mark accessible Story decisions as unavailable', async () => {
  const api = client({
    stories: {
      list: jest.fn(async () => ({ stories: [story], unavailableNodeIds: ['nod_offline'] })),
      listDecisions: jest.fn(async () => ({ decisions: [storyDecision] })),
      decideStory: jest.fn(async () => ({ ...storyDecision, status: 'decided', revision: 2 })),
    },
  });
  const controller = new MobileApprovalCenterController('cp_a', api, {
    aiSessions: () => ({ controlPlaneId: 'cp_a', messages: {}, sync: { phase: 'idle' } } as MobileAiSessionProfileState),
    directory: () => ({
      nodes: [
        { id: 'nod_a', name: 'Node A', status: 'online', health: 'ok', observedAt: now },
        { id: 'nod_offline', name: 'Offline', status: 'offline', health: 'unreachable', observedAt: now },
      ],
      instances: [],
    } as any),
    supportsAiSessions: false,
    supportsStories: true,
    supportsNodes: false,
  });

  await controller.start(new AbortController().signal);

  expect(controller.snapshot().sources['story-decision'].health).toMatchObject({ phase: 'ready', pendingCount: 1 });
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'story-decision')!;
  await controller.decide(item, { optionId: 'yes' });
  expect(api.stories.decideStory).toHaveBeenCalled();
});

test('an online node that cannot return Stories still marks the Story source stale', async () => {
  const api = client({
    stories: {
      list: jest.fn(async () => ({ stories: [story], unavailableNodeIds: ['nod_a'] })),
      listDecisions: jest.fn(async () => ({ decisions: [storyDecision] })),
      decideStory: jest.fn(async () => ({ ...storyDecision, status: 'decided', revision: 2 })),
    },
  });
  const controller = createController(api);

  await controller.start(new AbortController().signal);

  expect(controller.snapshot().sources['story-decision'].health).toMatchObject({
    phase: 'stale',
    diagnostic: 'SOURCE_PARTIAL',
  });
});

test('directory updates remap pending operation targets and node names without refetching approvals', async () => {
  const api = client();
  let currentDirectory = directory();
  currentDirectory = {
    nodes: [{ ...currentDirectory.nodes[0], name: 'Node Before' }],
    instances: [],
  };
  const controller = new MobileApprovalCenterController('cp_a', api, {
    aiSessions: aiState,
    directory: () => currentDirectory,
    supportsAiSessions: true,
    supportsStories: true,
    supportsNodes: true,
  });
  await controller.start(new AbortController().signal);

  const before = controller.snapshot().items.find((item) => item.type === 'operation-approval');
  expect(before?.type === 'operation-approval' ? before.targetName : undefined).toBeUndefined();
  expect(controller.snapshot().items.find((item) => item.type === 'node-control-plane-trust')).toMatchObject({ nodeName: 'Node Before' });

  currentDirectory = {
    nodes: [{ ...currentDirectory.nodes[0], name: 'Mac Mini' }],
    instances: directory().instances,
  };
  controller.syncDirectory();

  expect(controller.snapshot().items.find((item) => item.type === 'operation-approval')).toMatchObject({ targetName: 'Instance A' });
  expect(controller.snapshot().items.find((item) => item.type === 'node-control-plane-trust')).toMatchObject({ nodeName: 'Mac Mini' });
  expect(api.approvals.snapshot).toHaveBeenCalledTimes(1);
  expect(api.nodeAdmin.listControlPlaneTrust).toHaveBeenCalledTimes(1);
});

test('node trust is rescanned when the directory arrives after approval-center startup', async () => {
  const api = client();
  let currentDirectory: any = { nodes: [], instances: [] };
  const controller = new MobileApprovalCenterController('cp_a', api, {
    aiSessions: aiState,
    directory: () => currentDirectory,
    supportsAiSessions: true,
    supportsStories: true,
    supportsNodes: true,
  });
  await controller.start(new AbortController().signal);
  expect(api.nodeAdmin.listControlPlaneTrust).not.toHaveBeenCalled();
  expect(controller.snapshot().items.some((item) => item.type === 'node-control-plane-trust')).toBe(false);

  currentDirectory = directory();
  controller.syncDirectory();
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(api.nodeAdmin.listControlPlaneTrust).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().items.find((item) => item.type === 'node-control-plane-trust')).toMatchObject({
    nodeName: 'Node A',
    request: { requestId: 'ntr_a' },
  });
});

test('node control-plane trust events refresh the pending request without restarting the app', async () => {
  const api = client();
  let pending = false;
  (api.nodeAdmin.listControlPlaneTrust as jest.Mock).mockImplementation(async (nodeId: string) => ({
    nodeId,
    requests: pending ? [nodeRequest] : [],
    pins: [],
  }));
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  expect(controller.snapshot().items.some((item) => item.type === 'node-control-plane-trust')).toBe(false);

  pending = true;
  controller.applyEvent({
    type: 'node.control-plane-trust.changed',
    topic: 'nodes',
    payload: { nodeId: 'nod_a', requestId: nodeRequest.requestId, state: 'pending' },
    scope: { nodeId: 'nod_a' },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(api.nodeAdmin.listControlPlaneTrust).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().items.find((item) => item.type === 'node-control-plane-trust')).toMatchObject({
    nodeName: 'Node A',
    request: { requestId: 'ntr_a' },
  });
});

test('a failed source keeps its loaded pending projection and reports a sanitized stale diagnosis', async () => {
  const api = client();
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  (api.deviceTrust.snapshot as jest.Mock).mockRejectedValueOnce(new Error('sensitive upstream detail'));
  await controller.retry('device-trust');

  const state = controller.snapshot();
  const device = state.sources['device-trust'];
  expect(state.items.some((item) => item.type === 'device-trust')).toBe(true);
  expect(state.items).toHaveLength(5);
  expect(device.health.phase).toBe('stale');
  expect(device.health.pendingCount).toBe(1);
  expect(device.health.diagnostic).toBe('SOURCE_STALE');
  expect(JSON.stringify(state.items)).not.toContain('sensitive upstream detail');

  (api.deviceTrust.snapshot as jest.Mock).mockResolvedValueOnce({ revision: 2, requests: [deviceRequest], trustedDevices: [], roles: [] });
  await controller.retry('device-trust');
  expect(controller.snapshot().sources['device-trust'].health).toMatchObject({ phase: 'ready', pendingCount: 1 });
});

test('stale entries cannot submit while unrelated ready entries remain available', async () => {
  const api = client();
  const controller = createController(api);
  await controller.start(new AbortController().signal);
  (api.deviceTrust.snapshot as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await controller.retry('device-trust');
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'device-trust')!;

  await controller.decide(item, { decision: 'approve' });

  expect(api.deviceTrust.decide).not.toHaveBeenCalled();
  expect(controller.actionState(item.key)).toEqual({ phase: 'failed', error: 'SOURCE_UNAVAILABLE' });
});

test('operation events are revision-fenced so an old pending event cannot revive a terminal request', async () => {
  const controller = createController();
  await controller.start(new AbortController().signal);

  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: { request: operationRequest, status: 'denied', generation: operationGeneration, revision: 2 },
  });
  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: { request: { ...operationRequest, id: 'apr_b' }, status: 'pending', generation: operationGeneration, revision: 3 },
  });
  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: { request: operationRequest, status: 'pending', generation: operationGeneration, revision: 1 },
  });

  const requests = controller.snapshot().sources['operation-approval'].items;
  expect(requests.map((item) => item.type === 'operation-approval' && item.request.id)).toEqual(['apr_b']);
});

test('AI Session approval stays busy until the authoritative store removes it', async () => {
  let currentAi = aiState();
  const controller = createController(client(), { aiSessions: () => currentAi });
  await controller.start(new AbortController().signal);
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'ai-session-approval')!;

  await controller.decide(item, { decision: 'allow' });

  expect(controller.actionState(item.key).phase).toBe('busy');
  currentAi = {
    ...currentAi,
    snapshot: {
      ...currentAi.snapshot!,
      instances: [{
        ...currentAi.snapshot!.instances[0],
        aiSessions: { ...currentAi.snapshot!.instances[0].aiSessions, sessions: [] },
      }],
    },
  };
  controller.syncAiSessions();

  expect(controller.snapshot().items.some((candidate) => candidate.key === item.key)).toBe(false);
  expect(controller.actionState(item.key).phase).toBe('idle');
});

test('node trust uses normalized public capability and re-reads fingerprint and revision before deciding', async () => {
  const api = client();
  const updatedNodeRequest = { ...nodeRequest, fingerprint: `sha256:${'b'.repeat(43)}`, revision: 2 };
  (api.nodeAdmin.listControlPlaneTrust as jest.Mock).mockResolvedValue({
    nodeId: 'nod_a', requests: [updatedNodeRequest], pins: [],
  });
  const controller = createController(api);
  await controller.start(new AbortController().signal);
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'node-control-plane-trust')!;

  await controller.decide(item, { decision: 'approve' });

  expect(api.nodeAdmin.decideControlPlaneTrust).toHaveBeenCalledWith('nod_a', 'ntr_a', {
    action: 'approve',
    expectedFingerprint: updatedNodeRequest.fingerprint,
    expectedRevision: 2,
  });
});


test('Story and device trust decisions preserve the authoritative revision and fingerprint fences', async () => {
  const api = client();
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  const storyItem = controller.snapshot().items.find((item) => item.type === 'story-decision')!;
  await controller.decide(storyItem, { optionId: 'yes' });
  expect(api.stories.decideStory).toHaveBeenCalledWith('stry_a', 'dec_a', 'nod_a', {
    expectedRevision: 1,
    optionId: 'yes',
  });

  const deviceItem = controller.snapshot().items.find((item) => item.type === 'device-trust')!;
  await controller.decide(deviceItem, { decision: 'approve' });
  expect(api.deviceTrust.decide).toHaveBeenCalledWith('dtr_a', {
    decision: 'approve',
    expectedFingerprint: fingerprint,
    expectedRevision: 1,
  });
});

test('busy decisions are de-duplicated per approval key while other work remains independent', async () => {
  const api = client();
  let resolveDecision: ((value: unknown) => void) | undefined;
  (api.approvals.decide as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => {
    resolveDecision = resolve;
  }));
  const controller = createController(api);
  await controller.start(new AbortController().signal);
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'operation-approval')!;

  const first = controller.decide(item, { decision: 'approve' });
  await controller.decide(item, { decision: 'approve' });
  expect(api.approvals.decide).toHaveBeenCalledTimes(1);
  expect(controller.actionState(item.key).phase).toBe('busy');

  resolveDecision?.({ id: item.request.id, status: 'approved' });
  await first;
  expect(controller.snapshot().items.some((candidate) => candidate.key === item.key)).toBe(false);
});

test('a stale operation snapshot cannot revive a request after a newer terminal event', async () => {
  const api = client();
  let resolveSnapshot: ((value: unknown) => void) | undefined;
  (api.approvals.snapshot as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => {
    resolveSnapshot = resolve;
  }));
  const controller = createController(api);
  const starting = controller.start(new AbortController().signal);
  await Promise.resolve();

  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: { request: operationRequest, status: 'denied', generation: operationGeneration, revision: 2 },
  });
  resolveSnapshot?.({ generation: operationGeneration, revision: 1, requests: [operationRequest] });
  await starting;

  expect(controller.snapshot().sources['operation-approval'].items).toEqual([]);
});

test('a snapshot from the previous approval generation cannot overwrite a newer generation event', async () => {
  const api = client();
  let resolveInitialSnapshot: ((value: unknown) => void) | undefined;
  let resolveRecoveredSnapshot: ((value: unknown) => void) | undefined;
  (api.approvals.snapshot as jest.Mock)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveInitialSnapshot = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRecoveredSnapshot = resolve; }));
  const controller = createController(api);
  const starting = controller.start(new AbortController().signal);
  await Promise.resolve();

  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: {
      request: { ...operationRequest, id: 'apr_new_process' },
      status: 'pending',
      generation: 'approval_generation_b',
      revision: 1,
    },
  });
  resolveInitialSnapshot?.({ generation: operationGeneration, revision: 9, requests: [operationRequest] });
  await Promise.resolve();

  expect(controller.snapshot().sources['operation-approval'].items.map((item) => item.key)).toEqual([
    'cp_a:operation-approval:apr_new_process',
  ]);

  resolveRecoveredSnapshot?.({ generation: 'approval_generation_b', revision: 1, requests: [{ ...operationRequest, id: 'apr_new_process' }] });
  await starting;

  expect(controller.snapshot().sources['operation-approval'].items.map((item) => item.key)).toEqual([
    'cp_a:operation-approval:apr_new_process',
  ]);
});

test('a restarted approval register accepts its lower snapshot revision', async () => {
  const api = client();
  (api.approvals.snapshot as jest.Mock)
    .mockResolvedValueOnce({
      generation: 'approval_generation_b',
      revision: 0,
      requests: [],
    })
    .mockResolvedValueOnce({
      generation: 'approval_generation_c',
      revision: 1,
      requests: [{ ...operationRequest, id: 'apr_new_process' }],
    });
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  expect(controller.snapshot().sources['operation-approval'].items).toEqual([]);

  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: {
      request: { ...operationRequest, id: 'apr_new_process' },
      status: 'pending',
      generation: 'approval_generation_c',
      revision: 1,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(api.approvals.snapshot).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().sources['operation-approval'].items).toEqual([
    expect.objectContaining({ type: 'operation-approval', request: expect.objectContaining({ id: 'apr_new_process' }) }),
  ]);
});

test('operation generation recovery accepts the newest register after one retry', async () => {
  const api = client();
  (api.approvals.snapshot as jest.Mock)
    .mockResolvedValueOnce({ generation: 'approval_generation_b', revision: 1, requests: [] })
    .mockResolvedValueOnce({ generation: 'approval_generation_b', revision: 9, requests: [] })
    .mockResolvedValueOnce({
      generation: 'approval_generation_d',
      revision: 1,
      requests: [{ ...operationRequest, id: 'apr_latest_process' }],
    });
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  controller.applyEvent({
    type: 'operation-approval.changed',
    payload: {
      request: { ...operationRequest, id: 'apr_intermediate_process' },
      status: 'pending',
      generation: 'approval_generation_c',
      revision: 1,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(api.approvals.snapshot).toHaveBeenCalledTimes(3);
  expect(controller.snapshot().sources['operation-approval'].items).toEqual([
    expect.objectContaining({ type: 'operation-approval', request: expect.objectContaining({ id: 'apr_latest_process' }) }),
  ]);
});

test('Story refresh debounce accumulates every changed Story in one authoritative reload', async () => {
  const stories = [
    story,
    { ...story, id: 'stry_b', title: 'Story B' },
  ];
  const decisions = [
    storyDecision,
    { ...storyDecision, id: 'dec_b', storyId: 'stry_b' },
  ];
  const api = client({
    stories: {
      list: jest.fn(async () => ({ stories, unavailableNodeIds: [] })),
      listDecisions: jest.fn(async (storyId: string) => ({ decisions: decisions.filter((decision) => decision.storyId === storyId) })),
      decideStory: jest.fn(),
    },
  });
  const controller = createController(api);
  await controller.start(new AbortController().signal);
  (api.stories.list as jest.Mock).mockClear();
  (api.stories.listDecisions as jest.Mock).mockClear();

  for (const storyId of ['stry_a', 'stry_b']) {
    controller.applyEvent({
      type: 'story.decision.changed',
      payload: { storyId, decisionId: `dec_${storyId}`, revision: 2, change: 'expired' },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(api.stories.list).toHaveBeenCalledTimes(1);
  expect((api.stories.listDecisions as jest.Mock).mock.calls.map(([storyId]) => storyId).sort()).toEqual(['stry_a', 'stry_b']);
});

test('Node trust refresh debounce accumulates every changed online Node', async () => {
  const api = client({
    resources: {
      node: jest.fn(async (nodeId: string) => ({
        id: nodeId,
        name: nodeId === 'nod_a' ? 'Node A' : 'Node B',
        capabilities: {
          agent: { capabilities: { controlPlaneTrust: true } },
        },
      })),
    },
  });
  const twoNodes = {
    nodes: [
      { id: 'nod_a', name: 'Node A', status: 'online' as const, health: 'ok' as const, connectionMode: 'direct-http' as const, capabilities: [], observedAt: now },
      { id: 'nod_b', name: 'Node B', status: 'online' as const, health: 'ok' as const, connectionMode: 'direct-http' as const, capabilities: [], observedAt: now },
    ],
    instances: [],
  };
  const controller = new MobileApprovalCenterController('cp_a', api, {
    aiSessions: aiState,
    directory: () => twoNodes,
    supportsAiSessions: true,
    supportsStories: true,
    supportsNodes: true,
  });
  await controller.start(new AbortController().signal);
  (api.nodeAdmin.listControlPlaneTrust as jest.Mock).mockClear();

  for (const nodeId of ['nod_a', 'nod_b']) {
    controller.applyEvent({
      type: 'node.control-plane-trust.changed',
      topic: 'nodes',
      payload: { nodeId, controlPlaneId: 'cp_a', pinId: `pin_${nodeId}` },
      scope: { nodeId },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  expect((api.nodeAdmin.listControlPlaneTrust as jest.Mock).mock.calls.map(([nodeId]) => nodeId).sort()).toEqual(['nod_a', 'nod_b']);
});

test('node trust source is disabled solely by normalized capability absence', async () => {
  const api = client({
    resources: {
      node: jest.fn(async () => ({
        id: 'nod_a',
        name: 'Node A',
        capabilities: {
          agent: {
            capabilities: {
              stories: { agentToolCapabilities: { decisions: true } },
            },
          },
        },
      })),
    },
  });
  const controller = createController(api);
  await controller.start(new AbortController().signal);

  expect(api.nodeAdmin.listControlPlaneTrust).not.toHaveBeenCalled();
  expect(controller.snapshot().sources['node-control-plane-trust']).toMatchObject({
    items: [],
    health: { phase: 'ready', pendingCount: 0 },
  });
});

test('offline nodes never trigger node trust reads', async () => {
  const api = client();
  const controller = new MobileApprovalCenterController('cp_a', api, {
    aiSessions: aiState,
    directory: () => ({
      nodes: [{
        id: 'nod_offline',
        name: 'Offline Node',
        status: 'offline',
        health: 'unknown',
        connectionMode: 'direct-http',
        capabilities: [],
        observedAt: now,
      }],
      instances: directory().instances,
    }),
    supportsAiSessions: true,
    supportsStories: true,
    supportsNodes: true,
  });

  await controller.start(new AbortController().signal);

  expect(api.resources.node).not.toHaveBeenCalledWith('nod_offline', expect.anything());
  expect(api.nodeAdmin.listControlPlaneTrust).not.toHaveBeenCalled();
  expect(controller.snapshot().sources['node-control-plane-trust']).toMatchObject({
    items: [],
    health: { phase: 'ready', pendingCount: 0 },
  });
});

test('approval metrics contain source phases, counts and outcomes without approval identities', async () => {
  mobileMetrics.clear();
  const api = client();
  const controller = createController(api);
  await controller.start(new AbortController().signal);
  const item = controller.snapshot().items.find((candidate) => candidate.type === 'device-trust')!;
  await controller.decide(item, { decision: 'approve' });

  const metrics = mobileMetrics.snapshot().filter((metric) => metric.name.startsWith('mobile-approval-center.'));
  expect(metrics.some((metric) => metric.name.endsWith('.source'))).toBe(true);
  expect(metrics.some((metric) => metric.name.endsWith('.decision') && metric.dimensions.result === 'submitted')).toBe(true);
  expect(metrics.some((metric) => metric.name.endsWith('.decision') && metric.dimensions.result === 'acknowledged')).toBe(true);
  const encoded = JSON.stringify(metrics);
  expect(encoded).not.toContain(fingerprint);
  expect(encoded).not.toContain(deviceRequest.requestId);
  expect(encoded).not.toContain(deviceRequest.accountId);
});
