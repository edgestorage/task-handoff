import { setApplicationNightMode } from '../modules/task-handoff-appearance/src';

test('builds without the native appearance module degrade to a no-op', () => {
  expect(setApplicationNightMode('dark')).toBe(false);
  expect(setApplicationNightMode('light')).toBe(false);
  expect(setApplicationNightMode('system')).toBe(false);
});
