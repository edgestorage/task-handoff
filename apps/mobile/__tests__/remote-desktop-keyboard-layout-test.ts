import {
  REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT,
  remoteDesktopKeyboardObstruction,
  remoteDesktopNativeKeyboardReplacesVirtualSurface,
} from '../src/remote-desktop/keyboard-layout';

const base = {
  mode: 'system' as const,
  nativeKeyboardHeight: 0,
  open: true,
  virtualKeyboardHeight: 320,
  virtualKeyboardSurfaceVisible: false,
};

test('closed keyboards do not reserve space', () => {
  expect(remoteDesktopKeyboardObstruction({ ...base, open: false })).toBe(0);
  expect(remoteDesktopKeyboardObstruction({
    ...base,
    mode: 'virtual',
    open: false,
    virtualKeyboardSurfaceVisible: true,
  })).toBe(0);
});

test('an open virtual keyboard reserves its measured panel height', () => {
  expect(remoteDesktopKeyboardObstruction({
    ...base,
    mode: 'virtual',
    virtualKeyboardSurfaceVisible: true,
  })).toBe(320);
});

test('an open system keyboard includes the shared keyboard bar', () => {
  expect(remoteDesktopKeyboardObstruction({ ...base, nativeKeyboardHeight: 291 }))
    .toBe(291 + REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT);
});

test('switching from virtual to system keeps the current height until native geometry arrives', () => {
  expect(remoteDesktopKeyboardObstruction({ ...base, virtualKeyboardSurfaceVisible: true })).toBe(320);
  expect(remoteDesktopKeyboardObstruction({ ...base, nativeKeyboardHeight: 291 }))
    .toBe(291 + REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT);
});

test('switching from system to virtual ignores the native hide event', () => {
  expect(remoteDesktopKeyboardObstruction({
    ...base,
    mode: 'virtual',
    nativeKeyboardHeight: 0,
    virtualKeyboardSurfaceVisible: true,
  })).toBe(320);
});

test('native keyboard frame events only replace a visible virtual surface in system mode', () => {
  expect(remoteDesktopNativeKeyboardReplacesVirtualSurface('virtual', 291, true)).toBe(false);
  expect(remoteDesktopNativeKeyboardReplacesVirtualSurface('system', 291, true)).toBe(true);
  expect(remoteDesktopNativeKeyboardReplacesVirtualSurface('system', 0, false)).toBe(false);
});
