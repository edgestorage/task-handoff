import { fireEvent, render } from '@testing-library/react-native';
import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';

import { InitialSyncLoading, type InitialSyncConnection } from '../src/components/InitialSyncLoading';

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

const controlPlane = {
  id: 'control_plane_123',
  name: 'Home Control Plane',
  origin: 'https://cloud.example.test',
  source: 'Cloud Relay',
};

describe('<InitialSyncLoading /> device trust states', () => {
  test('shows the pending request identity and approval details without a retry action', async () => {
    const trust = outcome('pending');
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'waiting-device-approval', controlPlane, deviceTrust: trust }}
      resource="aiSessions"
      testID="device-trust-loading"
    />);

    expect(screen.getByTestId('device-trust-state')).toBeTruthy();
    expect(screen.getByText('Waiting for Control Plane approval')).toBeTruthy();
    expect(screen.getByText('Home Control Plane')).toBeTruthy();
    expect(screen.getByText('control_plane_123')).toBeTruthy();
    expect(screen.getByText('Cloud Relay · https://cloud.example.test')).toBeTruthy();
    expect(screen.getByText('Pixel test phone')).toBeTruthy();
    expect(screen.getByText('mobile · android · 1.2.3')).toBeTruthy();
    expect(screen.getByText(`sha256:${'p'.repeat(43)}`)).toBeTruthy();
    expect(screen.getByText('ABCD-EFGH-JKMN-NPQR')).toBeTruthy();
    expect(screen.getByText('devtrust_123')).toBeTruthy();
    expect(screen.getByText('First connection from this device')).toBeTruthy();
    expect(screen.queryByText('Request again')).toBeNull();
    expect(screen.queryByText('Connecting to Cloud Relay')).toBeNull();
  });

  test('offers an explicit retry for a rejected device', async () => {
    const retry = jest.fn();
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'rejected', controlPlane, deviceTrust: outcome('rejected', { reason: 'admin-rejected' }), onRetryDeviceTrust: retry }}
      resource="aiSessions"
    />);
    expect(screen.getByText('Device approval was rejected')).toBeTruthy();
    fireEvent.press(screen.getByText('Request again'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('explains a stale shared authorization separately from an admin rejection', async () => {
    const retry = jest.fn();
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'rejected', controlPlane, deviceTrust: outcome('rejected', { reason: 'authorization-stale' }), onRetryDeviceTrust: retry }}
      resource="aiSessions"
    />);
    expect(screen.getByText('Shared authorization expired')).toBeTruthy();
    expect(screen.getByText('This device\'s shared authorization is behind the Control Plane. Acquire the shared access again, then request device approval.')).toBeTruthy();
    expect(screen.queryByText('Device approval was rejected')).toBeNull();
    fireEvent.press(screen.getByText('Request again'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('does not offer a retry for an unsupported client', async () => {
    const retry = jest.fn();
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'trust-required', controlPlane, deviceTrust: outcome('trust-required', { reason: 'unsupported-client' }), onRetryDeviceTrust: retry }}
      resource="aiSessions"
    />);
    expect(screen.getByText('Update this client to connect')).toBeTruthy();
    expect(screen.queryByText('Request again')).toBeNull();
  });

  test('keeps approved state distinct from generic reconnecting copy', async () => {
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'approved-connecting', controlPlane, deviceTrust: outcome('pending') }}
      resource="aiSessions"
    />);
    expect(screen.getByText('Approved. Restoring the connection')).toBeTruthy();
    expect(screen.queryByText('Reconnecting to Cloud Relay')).toBeNull();
  });

  test('keeps role-change state distinct from generic reconnecting copy', async () => {
    const screen = await render(<InitialSyncLoading
      connection={{ phase: 'waiting-device-approval', controlPlane, deviceTrust: outcome('pending', { reason: 'role-changed' }) }}
      resource="aiSessions"
    />);
    expect(screen.getByText('This device needs approval again because its local role changed. An administrator must approve the request.')).toBeTruthy();
  });
});
