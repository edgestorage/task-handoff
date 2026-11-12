jest.mock('../src/remote-desktop/controller', () => {
  const instances: Array<{ close: jest.Mock; input: Record<string, unknown> }> = [];
  const RemoteDesktopController = jest.fn().mockImplementation((input: Record<string, unknown>) => {
    const controller = { close: jest.fn(async () => undefined), input };
    instances.push(controller);
    return controller;
  });
  return { RemoteDesktopController, __instances: instances };
});

type RegistryModule = typeof import('../src/remote-desktop/controller-registry');
const api = {} as never;
const transport = {} as never;

function loadRegistry(): RegistryModule {
  let registry: RegistryModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { registry = require('../src/remote-desktop/controller-registry') as RegistryModule; });
  return registry!;
}

function acquire(registry: RegistryModule, sessionId: string, active = true) {
  return registry.acquireRemoteDesktopController({
    controlPlaneId: 'cp_1',
    api,
    transport,
    instanceId: 'instance_1',
    sessionId,
    active,
    target: { kind: 'display', sourceRef: `source_${sessionId}` },
    resolution: 'auto',
    frameRate: 'auto',
    transportAvailability: { p2p: true, turn: true, websocket: true },
  });
}

test('reuses one controller for the same session scope', () => {
  const registry = loadRegistry();
  const first = acquire(registry, 'session_a');
  const second = acquire(registry, 'session_a');
  expect(second).toBe(first);
});

test('keeps two real controller scopes and evicts the least recently used inactive scope', () => {
  let now = 1;
  jest.spyOn(Date, 'now').mockImplementation(() => now++);
  const registry = loadRegistry();
  const first = acquire(registry, 'session_a');
  registry.markRemoteDesktopControllerActive({ controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_a' }, false);
  const second = acquire(registry, 'session_b');
  registry.markRemoteDesktopControllerActive({ controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_b' }, false);
  const third = acquire(registry, 'session_c');

  expect((first as unknown as { close: jest.Mock }).close).toHaveBeenCalledTimes(1);
  expect((second as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  expect((third as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();

  const fourth = acquire(registry, 'session_d');
  expect((second as unknown as { close: jest.Mock }).close).toHaveBeenCalledTimes(1);
  expect((third as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  expect((fourth as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

test('does not evict a currently active controller', () => {
  let now = 1;
  jest.spyOn(Date, 'now').mockImplementation(() => now++);
  const registry = loadRegistry();
  const first = acquire(registry, 'session_a');
  const second = acquire(registry, 'session_b');
  const third = acquire(registry, 'session_c');
  expect((first as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  expect((second as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  expect((third as unknown as { close: jest.Mock }).close).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
