import {
  canDisableTransport,
  defaultRemoteDesktopPreferences,
  REMOTE_DESKTOP_RESOLUTIONS,
  REMOTE_DESKTOP_RESOLUTION_PRESETS,
  remoteDesktopStreamResolution,
  transportEnabledCount,
} from '../src/remote-desktop/preferences';

test('offers automatic, 4K, 2K, 1080p and 540p without retired presets', () => {
  expect(defaultRemoteDesktopPreferences.capturePrecision).toBe('auto');
  expect(REMOTE_DESKTOP_RESOLUTIONS).toEqual(['auto', '4k', '2k', '1080p', '540p']);
  expect(REMOTE_DESKTOP_RESOLUTION_PRESETS['4k']).toEqual({ width: 3840, height: 2160 });
  expect(REMOTE_DESKTOP_RESOLUTION_PRESETS['2k']).toEqual({ width: 2560, height: 1440 });
  expect(remoteDesktopStreamResolution('4k', '30')).toEqual({ maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30, capturePrecision: 'auto' });
  expect(remoteDesktopStreamResolution('2k', 'auto')).toEqual({ maxWidth: 2560, maxHeight: 1440, maxFrameRate: null, capturePrecision: 'auto' });
  expect(remoteDesktopStreamResolution('auto', '60', 'performance')).toEqual({ maxWidth: null, maxHeight: null, maxFrameRate: 60, capturePrecision: 'performance' });
});

test('at most two remote desktop transports can be disabled', () => {
  const all = { p2p: true, turn: true, websocket: true };
  expect(transportEnabledCount(all)).toBe(3);
  expect(canDisableTransport(all, 'p2p')).toBe(true);
  expect(canDisableTransport(all, 'turn')).toBe(true);
  expect(canDisableTransport(all, 'websocket')).toBe(true);

  const two = { p2p: true, turn: false, websocket: true };
  expect(canDisableTransport(two, 'p2p')).toBe(true);
  expect(canDisableTransport(two, 'websocket')).toBe(true);

  const one = { p2p: false, turn: false, websocket: true };
  expect(canDisableTransport(one, 'websocket')).toBe(false);
  expect(canDisableTransport(one, 'p2p')).toBe(true);
});
