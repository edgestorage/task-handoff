import { fireEvent, render, waitFor } from '@testing-library/react-native';

import CloudAccountScreen from '../app/cloud-account';

const mockPublicProviders = jest.fn();
const mockBeginLogin = jest.fn();

jest.mock('expo-router', () => ({
  Redirect: () => null,
  router: { push: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({}),
}));
jest.mock('../src/control-plane/runtime', () => ({
  hasActiveCloudAccount: jest.fn(async () => false),
  mobileCloudAccountSession: {
    beginLogin: (...args: unknown[]) => mockBeginLogin(...args),
    client: { publicProviders: (...args: unknown[]) => mockPublicProviders(...args) },
    completeLogin: jest.fn(),
  },
  saveActiveCloudAccountReference: jest.fn(),
}));
jest.mock('../src/platform/build-variant', () => ({
  isMobileFeatureEnabled: () => true,
  mobileAppScheme: 'taskhandoff',
}));

test('renders every provider returned by the public directory in server order', async () => {
  mockPublicProviders.mockResolvedValue([
    { id: 'google', displayName: 'Google' },
    { id: 'github', displayName: 'GitHub' },
    { id: 'apple', displayName: 'Apple' },
    { id: 'workos', displayName: 'WorkOS SSO' },
  ]);

  const screen = await render(<CloudAccountScreen />);

  await waitFor(() => expect(screen.getByText('WorkOS SSO')).toBeTruthy());
  expect(screen.getByText('Google')).toBeTruthy();
  expect(screen.getByText('GitHub')).toBeTruthy();
  expect(screen.getByText('Apple')).toBeTruthy();

  await fireEvent.press(screen.getByText('WorkOS SSO'));
  expect(mockBeginLogin).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'workos' }));
});
