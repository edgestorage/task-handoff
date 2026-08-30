import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { TriggerForm } from '../src/triggers/TriggerForm';
import { emptyTriggerDraft } from '../src/triggers/model';

describe('<TriggerForm />', () => {
  test('guides creation with localized source choices, required validation, and advanced settings', async () => {
    const onSubmit = jest.fn(async () => undefined);
    const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <TriggerForm onSubmit={onSubmit} submitLabel="New Trigger" />
    </SafeAreaProvider>);

    expect(screen.getByText('Automate the next step')).toBeTruthy();
    expect(screen.getByTestId('trigger-form-footer-gradient')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Schedule' }).props.accessibilityState).toEqual({ checked: true });
    expect(screen.getByRole('button', { name: 'New Trigger' })).toBeDisabled();
    expect(screen.queryByText('Cooldown (milliseconds)')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Advanced settings' }));
    await waitFor(() => expect(screen.getByText('Cooldown (milliseconds)')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Review documentation');
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Trigger' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'New Trigger' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Review documentation',
      source: { type: 'schedule', scheduleKind: 'interval', intervalMs: 3_600_000 },
    })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Trigger' })).toBeEnabled());
  });

  test('requires a complete weekly schedule and file-change source', async () => {
    const weekly = emptyTriggerDraft();
    weekly.name = 'Weekly review';
    weekly.scheduleKind = 'weekly';
    weekly.weekdays = [];
    const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <TriggerForm initial={weekly} onSubmit={jest.fn(async () => undefined)} submitLabel="Save" />
    </SafeAreaProvider>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Mon' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await fireEvent.press(screen.getByRole('radio', { name: 'File changes' }));
    await fireEvent.changeText(screen.getByLabelText('Runtime roots, comma separated'), '');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });
});
