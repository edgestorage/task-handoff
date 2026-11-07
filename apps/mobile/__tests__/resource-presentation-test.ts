import { ResourcePresentationRegistry } from '../src/components/resource-presentation';

test('a resource has one presentation owner and releasing a foreground view restores its predecessor', () => {
  const registry = new ResourcePresentationRegistry();
  const first = Symbol('embedded');
  const second = Symbol('route');
  const releaseFirst = registry.claim('resource', first);
  expect(registry.owner('resource')).toBe(first);
  const releaseSecond = registry.claim('resource', second);
  expect(registry.owner('resource')).toBe(second);
  const releaseOther = registry.claim('other instance', Symbol('other'));
  expect(registry.owner('resource')).toBe(second);
  releaseSecond();
  expect(registry.owner('resource')).toBe(first);
  releaseFirst();
  expect(registry.owner('resource')).toBeUndefined();
  releaseOther();
});
