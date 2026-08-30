import { StandardReconnectTimer, standardReconnectDelayMs } from "@task-handoff/core/core/reconnect";

export const DEFAULT_EVENT_CONNECTION_SAFETY_INTERVAL_MS = 45_000;

export function eventConnectionSafetyIntervalMs(value?: number) {
  return Math.min(60_000, Math.max(30_000, value ?? DEFAULT_EVENT_CONNECTION_SAFETY_INTERVAL_MS));
}

export function eventConnectionRetryDelay(attempt: number, random = Math.random) {
  return standardReconnectDelayMs(attempt + 1, random);
}

export class EventConnectionRetryTimer extends StandardReconnectTimer {}
