import type { z } from 'zod';
import type { ControlPlaneClientTransport } from '@task-handoff/control-plane-client';
import type { AiSessionTransientSubscription } from '@task-handoff/protocol/events';

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
  id?: string;
  replay?: boolean;
  type: string;
  topic?: string;
  payload?: unknown;
  scope?: { instanceId?: string; nodeId?: string };
};

export type MobileControlPlaneEventHandlers = {
  topics?: readonly string[];
  aiSessionTransient?: AiSessionTransientSubscription;
  onOpen(): void;
  onEvent(event: MobileControlPlaneEvent): void;
  onError(error: MobileControlPlaneTransportError): void;
  onClose(): void;
};

export interface MobileControlPlaneEventConnection {
  close(): void;
  updateAiSessionTransient?(subscription: AiSessionTransientSubscription): void;
}

export type MobileAppSessionTtyHandlers = {
  onOpen(): void;
  onSnapshot(data: string, pendingEscape: string, cols: number, rows: number): void;
  onOutput(data: string): void;
  onResize(cols: number, rows: number): void;
  onExit(code?: number | null, signal?: string | null): void;
  onError(error: MobileControlPlaneTransportError): void;
  onClose(): void;
};

export interface MobileAppSessionTtyConnection {
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface MobileControlPlaneTransport extends ControlPlaneClientTransport {
  readonly profile: MobileControlPlaneProfile;
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
  revalidate?(): Promise<void>;
  connectEvents(handlers: MobileControlPlaneEventHandlers): MobileControlPlaneEventConnection;
  connectAppSessionTty(instanceId: string, sessionId: string, handlers: MobileAppSessionTtyHandlers): MobileAppSessionTtyConnection;
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
