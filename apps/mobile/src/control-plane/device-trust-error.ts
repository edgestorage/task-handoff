import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';
import { MobileControlPlaneTransportError } from './transport';

export class MobileDeviceTrustError extends MobileControlPlaneTransportError {
  readonly outcome: CloudClientTrustOutcome;

  constructor(outcome: CloudClientTrustOutcome) {
    super(
      'CLOUD_DEVICE_TRUST_REQUIRED',
      outcome.state === 'pending' ? 'The Control Plane is waiting for device approval.' : 'The Control Plane did not approve this device.',
      false,
    );
    this.name = 'MobileDeviceTrustError';
    this.outcome = outcome;
  }
}

export function isMobileDeviceTrustError(error: unknown): error is MobileDeviceTrustError {
  return error instanceof MobileDeviceTrustError;
}
