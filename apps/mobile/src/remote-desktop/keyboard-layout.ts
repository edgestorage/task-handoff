import type { RemoteDesktopKeyboardMode } from './virtual-keyboard';

export const REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT = 44;
export const DEFAULT_REMOTE_DESKTOP_KEYBOARD_DURATION_MS = 250;

export type RemoteDesktopKeyboardObstruction = {
  mode: RemoteDesktopKeyboardMode;
  nativeKeyboardHeight: number;
  open: boolean;
  virtualKeyboardHeight: number;
  virtualKeyboardSurfaceVisible: boolean;
};

export function remoteDesktopKeyboardObstruction(input: RemoteDesktopKeyboardObstruction) {
  if (!input.open) return 0;
  const virtualHeight = Math.max(0, input.virtualKeyboardHeight);
  if (input.mode === 'virtual') return virtualHeight;

  const nativeHeight = Math.max(0, input.nativeKeyboardHeight);
  if (nativeHeight > 0) return nativeHeight + REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT;
  // While switching from the virtual keyboard, keep the existing obstruction
  // until the native show event supplies the real height.
  return input.virtualKeyboardSurfaceVisible ? virtualHeight : 0;
}

export function remoteDesktopNativeKeyboardReplacesVirtualSurface(
  mode: RemoteDesktopKeyboardMode,
  nativeKeyboardHeight: number,
  nativeKeyboardVisible: boolean,
) {
  return mode === 'system' && nativeKeyboardVisible && nativeKeyboardHeight > 0;
}
