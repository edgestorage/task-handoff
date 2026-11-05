import { fireEvent, render, waitFor } from '@testing-library/react-native';

import CloudAccountScreen from '../app/cloud-account';

const mockNativeAppleAuthentication = jest.fn();
const mockLoginWithApple = jest.fn();
const mockConfirmProviderAccount = jest.fn();
const mockPublicProviders = jest.fn();
const mockBeginLogin = jest.fn();
const mockCompleteLogin = jest.fn();
const mockOpenAuthSessionAsync = jest.fn();

beforeEach(() => {
  mockNativeAppleAuthentication.mockReset();
  mockLoginWithApple.mockReset();
  mockConfirmProviderAccount.mockReset();
  mockPublicProviders.mockReset();
  mockBeginLogin.mockReset();
  mockCompleteLogin.mockReset();
  mockOpenAuthSessionAsync.mockReset();
  mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
});

jest.mock('../src/platform/apple-authentication', () => ({ nativeAppleAuthentication: () => mockNativeAppleAuthentication() }));

jest.mock('../src/components/NativeActionButton', () => jest.requireActual('../src/components/NativeActionButton.tsx'));

jest.mock('expo-router', () => ({
  Redirect: () => null,
  router: { push: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSessionAsync(...args),
}));
jest.mock('../src/control-plane/runtime', () => ({
  hasActiveCloudAccount: jest.fn(async () => false),
  mobileCloudAccountSession: {
    loginWithApple: (...args: unknown[]) => mockLoginWithApple(...args),
    confirmProviderAccount: (...args: unknown[]) => mockConfirmProviderAccount(...args),
    cancelProviderConfirmation: jest.fn(),
    beginLogin: (...args: unknown[]) => mockBeginLogin(...args),
    client: { publicProviders: (...args: unknown[]) => mockPublicProviders(...args) },
    completeLogin: (...args: unknown[]) => mockCompleteLogin(...args),
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

test('opens provider sign-in in an in-app auth session and completes its callback', async () => {
  const authorizationUrl = 'https://accounts.example.test/authorize?client_id=mobile';
  mockPublicProviders.mockResolvedValue([{ id: 'google', displayName: 'Google' }]);
  mockBeginLogin.mockResolvedValue({ authorizationUrl });
  mockOpenAuthSessionAsync.mockResolvedValue({
    type: 'success',
    url: 'taskhandoff://official-auth/callback?code=code_1&state=state_1',
  });

  const screen = await render(<CloudAccountScreen />);
  await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());

  await fireEvent.press(screen.getByText('Google'));

  await waitFor(() => expect(mockOpenAuthSessionAsync).toHaveBeenCalledWith(authorizationUrl, 'taskhandoff://official-auth/callback'));
  await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalledWith({
    code: 'code_1',
    state: 'state_1',
    redirectUri: 'taskhandoff://official-auth/callback',
  }));
});

test.each(['completed', 'cancelled'])('Apple native %s does not open a web auth session', async (outcome) => {
  const native = { bundleId: 'com.taskhandoff.mobile', signIn: jest.fn() };
  mockNativeAppleAuthentication.mockResolvedValue(native);
  mockPublicProviders.mockResolvedValue([{ id: 'apple', displayName: 'Apple' }]);
  mockLoginWithApple.mockResolvedValue(outcome);
  const screen = await render(<CloudAccountScreen />);
  await waitFor(() => expect(screen.getByText('Apple')).toBeTruthy());
  await fireEvent.press(screen.getByText('Apple'));
  await waitFor(() => expect(mockLoginWithApple).toHaveBeenCalledWith(native, 'taskhandoff://official-auth/callback'));
  expect(mockBeginLogin).not.toHaveBeenCalled();
  expect(mockOpenAuthSessionAsync).not.toHaveBeenCalled();
});

test('Apple first-time registration requires accepting terms in the app', async () => {
  mockNativeAppleAuthentication.mockResolvedValue({ bundleId: 'app', signIn: jest.fn() });
  mockPublicProviders.mockResolvedValue([{ id: 'apple', displayName: 'Apple' }]);
  mockLoginWithApple.mockResolvedValue('confirmation-required');
  const screen = await render(<CloudAccountScreen />);
  await waitFor(() => expect(screen.getByText('Apple')).toBeTruthy());
  await fireEvent.press(screen.getByText('Apple'));
  const checkbox = await screen.findByRole('checkbox');
  expect(mockConfirmProviderAccount).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Create Thandoff account' })).toBeDisabled();
  await fireEvent.press(checkbox);
  await fireEvent.press(screen.getByRole('button', { name: 'Create Thandoff account' }));
  await waitFor(() => expect(mockConfirmProviderAccount).toHaveBeenCalled());
  expect(mockOpenAuthSessionAsync).not.toHaveBeenCalled();
});
