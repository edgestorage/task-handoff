import type { z } from 'zod';
import type { ControlPlanePublicCapabilities } from '@task-handoff/protocol/control-plane-access';
import type { ControlPlaneClientTransport } from '@task-handoff/control-plane-client';
import {
  EventWireEnvelopeSchema,
  normalizeEventEnvelope,
  type AiSessionTransientSubscription,
  type EventScope,
} from '@task-handoff/protocol/events';

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

/**
 * Idle event streams are exactly what an intermediate reverse proxy or Relay
 * edge reaps, and the reaped stream comes back as a full directory bootstrap.
 * The Control Plane event transport answers this ping with a pong, matching
 * what the Control Plane web console already sends.
 */
export const MOBILE_EVENT_KEEPALIVE_INTERVAL_MS = 20_000;

export function mobileEventKeepaliveFrame(now: () => Date = () => new Date()) {
  return { v: 1 as const, type: 'ping' as const, sentAt: now().toISOString() };
}

export function normalizeMobileControlPlaneEvent(input: unknown, fallbackScope?: EventScope): MobileControlPlaneEvent | undefined {
  const parsed = EventWireEnvelopeSchema.safeParse(input);
  return parsed.success ? normalizeEventEnvelope(parsed.data, fallbackScope) : undefined;
}

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
  updateTopics?(topics: readonly string[]): void;
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
  readonly currentCapabilities?: ControlPlanePublicCapabilities;
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, onUploadProgress?: (progress: number) => void): Promise<T>;
  requestBinary(path: string, init?: RequestInit): Promise<{ body: Uint8Array; filename?: string; contentType?: string }>;
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
    readonly relayCloseCode?: number,
    readonly relayCloseReason?: string,
  ) {
    super(message);
    this.name = 'MobileControlPlaneTransportError';
  }
}

export const MOBILE_CONTROL_PLANE_CLOSED_MESSAGE = 'The Control Plane is closed.';

const MOBILE_CONTROL_PLANE_CLOSED_CODES = new Set([
  'RELAY_PEER_DETACHED',
  'CONTROL_PLANE_CONNECTION_CLOSED',
  'CONTROL_PLANE_CONNECTION_UNAVAILABLE',
  'CONTROL_PLANE_UNAVAILABLE',
  'CONTROL_PLANE_UNREACHABLE',
]);

export function mobileControlPlaneClosedErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = String((error as { code?: unknown }).code ?? '');
  return MOBILE_CONTROL_PLANE_CLOSED_CODES.has(code) ? code : undefined;
}
