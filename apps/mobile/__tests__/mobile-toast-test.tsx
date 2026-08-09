import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MobileToastProvider, useMobileToast } from '../src/components/MobileToast';

function ToastTrigger() {
  const toast = useMobileToast();
  return <Pressable onPress={() => toast.show({ detail: 'Control Plane request failed with HTTP 404.', durationMs: 60_000, title: 'Reorder failed' })}>
    <Text>Show toast</Text>
  </Pressable>;
}

test('shows, deduplicates, and dismisses a global action-error toast', async () => {
  const screen = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <MobileToastProvider><ToastTrigger /></MobileToastProvider>
    </SafeAreaProvider>,
  );

  await fireEvent.press(screen.getByText('Show toast'));
  await fireEvent.press(screen.getByText('Show toast'));

  expect(screen.getAllByTestId('mobile-toast')).toHaveLength(1);
  screen.getByText('Reorder failed');
  screen.getByText('Control Plane request failed with HTTP 404.');

  await fireEvent.press(screen.getByTestId('mobile-toast'));
  await waitFor(() => expect(screen.queryByTestId('mobile-toast')).toBeNull());
});
