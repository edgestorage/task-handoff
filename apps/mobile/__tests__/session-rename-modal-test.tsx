import { act, fireEvent, render } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionRenameModal } from '../src/components/SessionRenameModal';

const initialWindowMetrics = Dimensions.get('window');
const initialScreenMetrics = Dimensions.get('screen');

afterEach(async () => {
  await act(async () => Dimensions.set({ screen: initialScreenMetrics, window: initialWindowMetrics }));
});

test('validates rename input and exposes accessible controls', async () => {
  const submit = jest.fn();
  const close = jest.fn();
  const screen = await render(<SessionRenameModal busy={false} initialTitle="Original" onClose={close} onSubmit={submit} open />);
  const input = screen.getByLabelText('Session title');
  const save = screen.getByRole('button', { name: 'Save' });

  await fireEvent.changeText(input, '   ');
  await fireEvent.press(save);
  expect(submit).toHaveBeenCalledWith('');
  submit.mockClear();

  await fireEvent.changeText(input, 'x'.repeat(121));
  await fireEvent.press(save);
  screen.getByText('Session title must be 120 characters or fewer.');
  expect(submit).not.toHaveBeenCalled();

  await fireEvent.changeText(input, '  Renamed  ');
  await fireEvent.press(save);
  expect(submit).toHaveBeenCalledWith('Renamed');
  await screen.unmount();
});

test('retains the draft and blocks submit while a failed request is busy', async () => {
  const submit = jest.fn();
  const close = jest.fn();
  const screen = await render(<SessionRenameModal busy={false} initialTitle="Original" onClose={close} onSubmit={submit} open />);
  const input = screen.getByLabelText('Session title');

  await fireEvent.changeText(input, 'Draft title');
  await screen.rerender(<SessionRenameModal busy initialTitle="Original" error="Conflict" onClose={close} onSubmit={submit} open />);
  expect(screen.getByLabelText('Session title').props.value).toBe('Draft title');
  screen.getByText('Conflict');
  await fireEvent.press(screen.getByRole('button', { name: 'Saving…' }));
  expect(submit).not.toHaveBeenCalled();
  await screen.unmount();
});

test('keeps the rename dialog content clear of the Duo outer-display tab rail', async () => {
  await act(async () => Dimensions.set({
    screen: { ...initialScreenMetrics, width: 466 },
    window: { ...initialWindowMetrics, width: 466 },
  }));
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 466, height: 678 }, insets: { top: 0, right: 84, bottom: 34, left: 0 } }}>
    <SessionRenameModal busy={false} initialTitle="Original" onClose={() => undefined} onSubmit={() => undefined} open />
  </SafeAreaProvider>);

  expect(screen.getByTestId('session-rename-content-column')).toHaveStyle({ marginLeft: 0, marginRight: 84 });
  expect(screen.getByLabelText('Cancel')).toHaveStyle({ bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 });
});
