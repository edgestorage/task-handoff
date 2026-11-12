import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  FLOATING_PREVIEW_EXIT_DURATION_MS,
  useFloatingPreviewPresence,
} from '../src/remote-desktop/floating-preview-presence';

function PresenceProbe({ reduceMotion, visible }: { reduceMotion: boolean; visible: boolean }) {
  const present = useFloatingPreviewPresence(visible, reduceMotion);
  return <Text testID="presence">{present ? 'present' : 'absent'}</Text>;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('keeps the preview mounted for the exit transition before unmounting it', async () => {
  const screen = await render(<PresenceProbe reduceMotion={false} visible />);
  expect(screen.getByTestId('presence').props.children).toBe('present');

  await act(async () => screen.rerender(<PresenceProbe reduceMotion={false} visible={false} />));
  expect(screen.getByTestId('presence').props.children).toBe('present');

  await act(async () => jest.advanceTimersByTime(FLOATING_PREVIEW_EXIT_DURATION_MS - 1));
  expect(screen.getByTestId('presence').props.children).toBe('present');

  await act(async () => jest.advanceTimersByTime(1));
  expect(screen.getByTestId('presence').props.children).toBe('absent');
  screen.unmount();
});

test('reopening during the exit transition cancels the pending unmount', async () => {
  const screen = await render(<PresenceProbe reduceMotion={false} visible />);

  await act(async () => screen.rerender(<PresenceProbe reduceMotion={false} visible={false} />));
  await act(async () => jest.advanceTimersByTime(FLOATING_PREVIEW_EXIT_DURATION_MS - 1));
  await act(async () => screen.rerender(<PresenceProbe reduceMotion={false} visible />));
  await act(async () => jest.advanceTimersByTime(FLOATING_PREVIEW_EXIT_DURATION_MS));

  expect(screen.getByTestId('presence').props.children).toBe('present');
  screen.unmount();
});

test('reduce motion unmounts immediately without waiting for an exit transition', async () => {
  const screen = await render(<PresenceProbe reduceMotion visible />);

  await act(async () => screen.rerender(<PresenceProbe reduceMotion visible={false} />));
  await act(async () => jest.advanceTimersByTime(0));

  expect(screen.getByTestId('presence').props.children).toBe('absent');
  screen.unmount();
});
