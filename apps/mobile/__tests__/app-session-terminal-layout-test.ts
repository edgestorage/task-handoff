import { APP_SESSION_TERMINAL_FONT_SIZE, appSessionPaneTopInset, appSessionTerminalKeyboardBehavior, appSessionTerminalKeyboardOffset } from '../src/app-sessions/terminal-layout';

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

test('insets only transparent embedded pane headers', () => {
  expect(appSessionPaneTopInset('ios', true, 82)).toBe(82);
  expect(appSessionPaneTopInset('ios', false, 82)).toBe(0);
  expect(appSessionPaneTopInset('android', true, 82)).toBe(0);
  expect(appSessionPaneTopInset('ios', true, -1)).toBe(0);
});
