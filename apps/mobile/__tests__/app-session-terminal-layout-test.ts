import { APP_SESSION_TERMINAL_FONT_SIZE, appSessionTerminalKeyboardBehavior, appSessionTerminalKeyboardOffset } from '../src/app-sessions/terminal-layout';

test('uses the compact App Session terminal font size', () => {
  expect(APP_SESSION_TERMINAL_FONT_SIZE).toBe(10);
});

test('shrinks the iOS terminal viewport for the soft keyboard', () => {
  expect(appSessionTerminalKeyboardBehavior('ios')).toBe('height');
  expect(appSessionTerminalKeyboardBehavior('android')).toBeUndefined();
  expect(appSessionTerminalKeyboardOffset('ios', '26.5')).toBe(120);
  expect(appSessionTerminalKeyboardOffset('ios', 25)).toBe(112);
  expect(appSessionTerminalKeyboardOffset('android', 36)).toBe(0);
});
