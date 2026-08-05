import type { z } from 'zod';
import type { ControlPlaneClientTransport } from '@task-handoff/control-plane-client';

import type {
  MobileControlPlaneCapabilities,
  MobileControlPlaneIdentity,
  MobileControlPlaneProfile,
} from './profile';

export type MobileControlPlaneProbe = {
  identity: MobileControlPlaneIdentity;
  capabilities: MobileControlPlaneCapabilities;
};

export type MobileControlPlaneEvent = {
  type: string;
  topic?: string;
  payload?: unknown;
  scope?: { instanceId?: string; nodeId?: string };
};

export type MobileControlPlaneEventHandlers = {
  onOpen(): void;
  onEvent(event: MobileControlPlaneEvent): void;
  onError(error: MobileControlPlaneTransportError): void;
  onClose(): void;
};

export interface MobileControlPlaneEventConnection {
  close(): void;
}

export interface MobileControlPlaneTransport extends ControlPlaneClientTransport {
  readonly profile: MobileControlPlaneProfile;
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
  revalidate?(): Promise<void>;
  connectEvents(handlers: MobileControlPlaneEventHandlers): MobileControlPlaneEventConnection;
}

export class MobileControlPlaneTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MobileControlPlaneTransportError';
  }
}
