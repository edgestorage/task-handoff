import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LicenseListScreen } from '../src/licenses/LicenseListScreen';
import { mobileLicenseData } from '../src/licenses/model';
import { LicenseDetailScreen } from '../src/licenses/LicenseDetailScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockParams = jest.fn(() => ({ licenseId: 'project' }));

jest.mock('expo-router', () => ({
  router: { back: () => mockBack(), push: (...args: unknown[]) => mockPush(...args) },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams(),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } };

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
  mockParams.mockReturnValue({ licenseId: 'project' });
});

test('renders the bundled inventory and searches package names', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><LicenseListScreen /></SafeAreaProvider>);

  expect(screen.getByText('TaskHandoff')).toBeTruthy();
  expect(screen.getByText(`${mobileLicenseData.packageCount} packages`)).toBeTruthy();
  expect(screen.getAllByTestId('license-package-row').length).toBeGreaterThan(0);

  await fireEvent.changeText(screen.getByPlaceholderText('Search packages or licenses…'), 'react-native');
  const matchingCount = mobileLicenseData.packages.filter((item) => [item.name, item.version, item.license]
    .some((value) => value.toLowerCase().includes('react-native'))).length;
  expect(await screen.findByText(`${matchingCount} packages`)).toBeTruthy();
  expect(screen.getAllByTestId('license-package-row').length).toBeGreaterThan(0);
});

test('opens the application license entry', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><LicenseListScreen /></SafeAreaProvider>);

  await fireEvent.press(screen.getByTestId('license-project-row'));
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
    params: { licenseId: 'project' },
    pathname: '/licenses/[licenseId]',
  }));
});

test('renders the selected license text and notice', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><LicenseDetailScreen /></SafeAreaProvider>);

  expect(screen.getByText('TaskHandoff')).toBeTruthy();
  expect(screen.getByText('Apache-2.0')).toBeTruthy();
  expect(screen.getAllByText('License text').length).toBeGreaterThan(0);
  expect(screen.getByText('Notice')).toBeTruthy();
});
