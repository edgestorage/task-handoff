import { fireEvent, render } from '@testing-library/react-native';
import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';

import { MobileDeviceTrustGate } from '../src/control-plane/MobileDeviceTrustGate';

let mockRuntime: {
  phase: string;
  deviceTrust?: CloudClientTrustOutcome;
  retryDeviceTrust: () => boolean;
} = { phase: 'connected', retryDeviceTrust: () => false };

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: () => mockRuntime,
  useOptionalMobileControlPlaneRuntime: () => mockRuntime,
}));

function outcome(state: CloudClientTrustOutcome['state'], overrides: Partial<CloudClientTrustOutcome> = {}): CloudClientTrustOutcome {
  return {
    protocolVersion: '2026-10-26',
    audience: 'task-handoff:cloud-device-trust',
    state,
    ...(state === 'pending' ? { reason: 'first-seen' as const, requestId: 'devtrust_123' } : {}),
    controlPlaneId: 'control_plane_123',
    bindingId: 'binding_123',
    ticketId: 'rtt_ticket_123',
    accountId: 'account_123',
    deviceSessionId: 'device_session_123',
    controlPlanePublicKey: 'q'.repeat(43),
    device: { name: 'Pixel test phone', kind: 'mobile', platform: 'android', version: '1.2.3' },
    devicePublicKeyFingerprint: `sha256:${'p'.repeat(43)}`,
    comparisonCode: 'ABCD-EFGH-JKMN-NPQR',
    issuedAt: '2026-10-26T00:00:00.000Z',
    expiresAt: '2026-10-27T00:00:00.000Z',
    signature: 's'.repeat(86),
    ...overrides,
  };
}

afterEach(() => {
  mockRuntime = { phase: 'connected', retryDeviceTrust: () => false };
});

describe('<MobileDeviceTrustGate />', () => {
  test('blocks cached content while the device is waiting for approval', async () => {
    mockRuntime = {
      phase: 'waiting-device-approval',
      deviceTrust: outcome('pending'),
      retryDeviceTrust: () => false,
    };
    const screen = await render(<MobileDeviceTrustGate />);

    expect(screen.getByTestId('device-trust-gate')).toBeTruthy();
    expect(screen.getByText('Waiting for Control Plane approval')).toBeTruthy();
    expect(screen.getByText('Pixel test phone')).toBeTruthy();
  });

  test('offers a way back to settings while the device is waiting for approval', async () => {
    const openSettings = jest.fn();
    mockRuntime = {
      phase: 'waiting-device-approval',
      deviceTrust: outcome('pending'),
      retryDeviceTrust: () => false,
    };
    const screen = await render(<MobileDeviceTrustGate onOpenSettings={openSettings} />);

    fireEvent.press(screen.getByText('Back to settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test('surfaces explicit retry for a revoked device instead of cached data', async () => {
    const retry = jest.fn(() => true);
    mockRuntime = {
      phase: 'revoked',
      deviceTrust: outcome('revoked', { reason: 'device-revoked' }),
      retryDeviceTrust: retry,
    };
    const screen = await render(<MobileDeviceTrustGate />);

    expect(screen.getByText('Device trust was revoked')).toBeTruthy();
    fireEvent.press(screen.getByText('Request again'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('does not block an approved live connection', async () => {
    mockRuntime = { phase: 'connected', deviceTrust: outcome('pending'), retryDeviceTrust: () => false };
    const screen = await render(<MobileDeviceTrustGate />);
    expect(screen.queryByTestId('device-trust-gate')).toBeNull();
  });
});
