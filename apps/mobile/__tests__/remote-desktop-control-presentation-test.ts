import { emptyRemoteDesktopSnapshot } from '../src/remote-desktop/types';
import {
  remoteDesktopControlHint,
  shouldShowControlRequest,
} from '../src/remote-desktop/control-presentation';

test('shows the control action only until this viewer owns input control', () => {
  expect(shouldShowControlRequest({ ...emptyRemoteDesktopSnapshot, isController: false })).toBe(true);
  expect(shouldShowControlRequest({ ...emptyRemoteDesktopSnapshot, isController: true })).toBe(false);
});

test('explains why a surface tap cannot send input', () => {
  expect(remoteDesktopControlHint({
    ...emptyRemoteDesktopSnapshot,
    isController: false,
    hasController: true,
  })).toBe('another-viewer');
  expect(remoteDesktopControlHint({
    ...emptyRemoteDesktopSnapshot,
    isController: false,
    hasController: false,
  })).toBe('control-available');
  expect(remoteDesktopControlHint({
    ...emptyRemoteDesktopSnapshot,
    isController: true,
    hasController: false,
  })).toBeUndefined();
  expect(remoteDesktopControlHint({
    ...emptyRemoteDesktopSnapshot,
    isController: false,
    hasController: true,
    paused: true,
  })).toBeUndefined();
});
