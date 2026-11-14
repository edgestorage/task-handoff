jest.mock('../src/remote-desktop/controller', () => {
  const instances: Array<{ close: jest.Mock; input: Record<string, unknown> }> = [];
  const RemoteDesktopController = jest.fn().mockImplementation((input: Record<string, unknown>) => {
    const controller = {
      close: jest.fn(async () => undefined),
      input,
      setActive: jest.fn(),
      setInteractive: jest.fn(),
      setResolution: jest.fn(),
    };
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
    capturePrecision: 'auto',
    transportAvailability: { p2p: true, turn: true, websocket: true },
  });
}

function scope(sessionId: string) {
  return { controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId };
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
  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), {}, { active: false, interactive: false, resolution: 'auto' });
  const second = acquire(registry, 'session_b');
  registry.updateRemoteDesktopControllerConsumer(scope('session_b'), {}, { active: false, interactive: false, resolution: 'auto' });
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

test('keeps a shared controller active until the last consumer releases its lease', () => {
  const registry = loadRegistry();
  const controller = acquire(registry, 'session_a') as unknown as {
    setActive: jest.Mock;
    setInteractive: jest.Mock;
  };
  const previewConsumer = {};
  const detailConsumer = {};

  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), previewConsumer, {
    active: true,
    interactive: false,
    resolution: '540p',
  });
  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), detailConsumer, {
    active: true,
    interactive: true,
    resolution: 'auto',
  });
  registry.releaseRemoteDesktopControllerConsumer(scope('session_a'), previewConsumer);

  expect(controller.setActive).toHaveBeenLastCalledWith(true);
  expect(controller.setInteractive).toHaveBeenLastCalledWith(true);

  registry.releaseRemoteDesktopControllerConsumer(scope('session_a'), detailConsumer);

  expect(controller.setActive).toHaveBeenLastCalledWith(false);
  expect(controller.setInteractive).toHaveBeenLastCalledWith(false);
});

test('keeps the preview resolution provisional until the interactive viewer releases it', () => {
  const registry = loadRegistry();
  const controller = acquire(registry, 'session_a') as unknown as {
    setResolution: jest.Mock;
  };
  const previewConsumer = {};
  const detailConsumer = {};

  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), previewConsumer, {
    active: true,
    interactive: false,
    resolution: '540p',
  });
  expect(controller.setResolution).toHaveBeenLastCalledWith('540p');

  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), detailConsumer, {
    active: false,
    interactive: true,
    resolution: 'auto',
  });
  expect(controller.setResolution).toHaveBeenLastCalledWith('540p');

  registry.updateRemoteDesktopControllerConsumer(scope('session_a'), detailConsumer, {
    active: true,
    interactive: true,
    resolution: 'auto',
  });

  expect(controller.setResolution).toHaveBeenLastCalledWith('auto');

  registry.releaseRemoteDesktopControllerConsumer(scope('session_a'), detailConsumer);
  expect(controller.setResolution).toHaveBeenLastCalledWith('540p');

  registry.releaseRemoteDesktopControllerConsumer(scope('session_a'), previewConsumer);
  expect(controller.setResolution).toHaveBeenLastCalledWith('540p');
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
