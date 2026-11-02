import { instanceControlActions } from '../src/instances/instance-lifecycle';

test('shows only the instance lifecycle actions projected as available', () => {
  expect(instanceControlActions(['stop', 'restart'])).toEqual(['stop', 'restart']);
  expect(instanceControlActions(['start', 'retry-git'])).toEqual(['start', 'retry-git']);
  expect(instanceControlActions(['retry-image', 'restart', 'stop', 'start'])).toEqual(['start', 'stop', 'restart', 'retry-image']);
  expect(instanceControlActions([])).toEqual([]);
});
