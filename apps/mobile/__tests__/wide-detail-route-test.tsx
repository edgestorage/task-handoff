import { act, render } from '@testing-library/react-native';

import { useWideDetailRoute } from '../src/master-detail/use-wide-detail-route';

const mockFocused = { value: false };
const mockDismissTo = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: mockDismissTo }),
}));

jest.mock('expo-router/react-navigation', () => ({
  useIsFocused: () => mockFocused.value,
}));

function Probe({ wide }: { wide: boolean }) {
  useWideDetailRoute({
    href: '/(tabs)/(main)/inbox',
    selectionKey: 'control-plane:instance:session',
    select: () => undefined,
    wide,
  });
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused.value = false;
});

test('a covered compact detail does not dismiss an open remote desktop when the device rotates wide', async () => {
  const screen = await render(<Probe wide={false} />);

  await act(async () => { screen.rerender(<Probe wide />); });
  expect(mockDismissTo).not.toHaveBeenCalled();
});

test('a focused compact detail still collapses into its wide workbench', async () => {
  const screen = await render(<Probe wide={false} />);

  mockFocused.value = true;
  await act(async () => { screen.rerender(<Probe wide />); });
  expect(mockDismissTo).toHaveBeenCalledWith('/(tabs)/(main)/inbox');
});
