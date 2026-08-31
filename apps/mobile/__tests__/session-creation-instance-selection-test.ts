import {
  MobileSessionCreationInstanceStore,
  preferredSessionCreationInstanceId,
} from '../src/session-creation/instance-selection';

const instances = [{ id: 'instance-a' }, { id: 'instance-b' }];

test('an explicitly scoped instance wins over the remembered selection', () => {
  expect(preferredSessionCreationInstanceId(instances, 'instance-a', 'instance-b')).toBe('instance-a');
});

test('a valid remembered instance is reused when no instance is explicitly scoped', () => {
  expect(preferredSessionCreationInstanceId(instances, undefined, 'instance-b')).toBe('instance-b');
});

test('removed requested and remembered instances are ignored', () => {
  expect(preferredSessionCreationInstanceId(instances, 'removed-a', 'removed-b')).toBeUndefined();
});

test('AI and App selections are isolated per Control Plane', () => {
  const store = new MobileSessionCreationInstanceStore();
  store.write('control-plane-a', 'ai', 'instance-a');
  store.write('control-plane-a', 'app', 'instance-b');
  store.write('control-plane-b', 'ai', 'instance-b');

  expect(store.read('control-plane-a', 'ai')).toBe('instance-a');
  expect(store.read('control-plane-a', 'app')).toBe('instance-b');
  expect(store.read('control-plane-b', 'ai')).toBe('instance-b');
  expect(store.read('control-plane-b', 'app')).toBeUndefined();
});
