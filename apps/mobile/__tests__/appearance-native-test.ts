jest.mock('expo', () => ({
  requireOptionalNativeModule: jest.fn(() => ({ setApplicationNightMode: jest.fn(() => true) })),
}));

import { setApplicationNightMode } from '../modules/task-handoff-appearance/src';

test('forwards the in-app appearance preference to the native application night mode', () => {
  expect(setApplicationNightMode('dark')).toBe(true);
  const native = (jest.requireMock('expo').requireOptionalNativeModule as jest.Mock).mock.results[0].value;
  expect(native.setApplicationNightMode).toHaveBeenCalledWith('dark');

  expect(setApplicationNightMode('system')).toBe(true);
  expect(native.setApplicationNightMode).toHaveBeenLastCalledWith('system');
});
