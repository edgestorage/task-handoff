import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AboutScreen } from '../src/about/AboutScreen';

const mockPush = jest.fn();
const mockOpenAppBrowser = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));
jest.mock('../src/browser/app-browser', () => ({
  openAppBrowser: (...args: unknown[]) => mockOpenAppBrowser(...args),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } };

beforeEach(() => {
  mockPush.mockClear();
  mockOpenAppBrowser.mockClear();
});

test('shows product information and opens bundled licenses in the app', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><AboutScreen /></SafeAreaProvider>);

  expect(screen.getByText('TaskHandoff')).toBeTruthy();
  expect(screen.getByText('Privacy Policy')).toBeTruthy();
  expect(screen.getByText('Open Source Licenses')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('about-licenses'));
  expect(mockPush).toHaveBeenCalledWith('/licenses');
});

test('opens privacy and terms through the localized cloud pages', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><AboutScreen /></SafeAreaProvider>);

  await fireEvent.press(screen.getByTestId('about-privacy'));
  expect(mockOpenAppBrowser).toHaveBeenCalledWith(expect.stringMatching(/\/privacy\?lang=en$/));
  await fireEvent.press(screen.getByTestId('about-terms'));
  expect(mockOpenAppBrowser).toHaveBeenCalledWith(expect.stringMatching(/\/terms\?lang=en$/));
});
