import type { CarPlayProjection } from './model';

export function updateCarPlay(_projection: CarPlayProjection) {}
export async function isCarPlayConnected() { return false; }
export function subscribeToCarPlayConnection(_listener: (connected: boolean) => void) {
  return () => undefined;
}
