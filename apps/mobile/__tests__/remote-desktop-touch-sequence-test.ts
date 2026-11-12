import {
  EMPTY_REMOTE_DESKTOP_TOUCH_SEQUENCE,
  canCommitRemoteDesktopMultiTouchTap,
  startRemoteDesktopTouchSequence,
  suppressRemoteDesktopTap,
  updateRemoteDesktopTouchSequence,
} from '../src/remote-desktop/touch-sequence';

test('a residual finger after multitouch cannot become a tap', () => {
  let sequence = startRemoteDesktopTouchSequence(EMPTY_REMOTE_DESKTOP_TOUCH_SEQUENCE, 1);
  expect(suppressRemoteDesktopTap(sequence)).toBe(false);

  sequence = startRemoteDesktopTouchSequence(sequence, 2);
  expect(suppressRemoteDesktopTap(sequence)).toBe(true);

  sequence = updateRemoteDesktopTouchSequence(sequence, 1);
  expect(suppressRemoteDesktopTap(sequence)).toBe(true);

  sequence = updateRemoteDesktopTouchSequence(sequence, 0);
  expect(suppressRemoteDesktopTap(sequence)).toBe(true);
});

test('a fresh single-finger sequence restores tap handling', () => {
  let sequence = startRemoteDesktopTouchSequence(EMPTY_REMOTE_DESKTOP_TOUCH_SEQUENCE, 2);
  sequence = updateRemoteDesktopTouchSequence(sequence, 0);

  sequence = startRemoteDesktopTouchSequence(sequence, 1);
  expect(suppressRemoteDesktopTap(sequence)).toBe(false);
});

test('ordinary single-touch movement remains tappable at release', () => {
  let sequence = startRemoteDesktopTouchSequence(EMPTY_REMOTE_DESKTOP_TOUCH_SEQUENCE, 1);
  sequence = updateRemoteDesktopTouchSequence(sequence, 1);
  sequence = updateRemoteDesktopTouchSequence(sequence, 0);
  expect(suppressRemoteDesktopTap(sequence)).toBe(false);
});

test('only a short pending two-finger gesture becomes a right click', () => {
  expect(canCommitRemoteDesktopMultiTouchTap(
    { eligible: true, intent: 'pending', startedAt: 1_000 },
    1_300,
  )).toBe(true);
  expect(canCommitRemoteDesktopMultiTouchTap(
    { eligible: false, intent: 'pending', startedAt: 1_000 },
    1_300,
  )).toBe(false);
  expect(canCommitRemoteDesktopMultiTouchTap(
    { eligible: true, intent: 'pinch', startedAt: 1_000 },
    1_300,
  )).toBe(false);
  expect(canCommitRemoteDesktopMultiTouchTap(
    { eligible: true, intent: 'pending', startedAt: 1_000 },
    1_800,
  )).toBe(false);
});
