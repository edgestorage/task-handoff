import { fireEvent, render } from '@testing-library/react-native';

import { SessionRenameModal } from '../src/components/SessionRenameModal';

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
