import { NativeEventEmitter, NativeModules } from 'react-native';

import type { CarPlayProjection } from './model';

type NativeCarPlayModule = {
  isConnected(): Promise<boolean>;
  update(projection: CarPlayProjection): void;
};

const nativeModule = NativeModules.TaskHandoffCarPlay as NativeCarPlayModule | undefined;
const emitter = nativeModule ? new NativeEventEmitter(NativeModules.TaskHandoffCarPlay) : undefined;

export function updateCarPlay(projection: CarPlayProjection) {
  if (typeof nativeModule?.update === 'function') nativeModule.update(projection);
}

export async function isCarPlayConnected() {
  return typeof nativeModule?.isConnected === 'function' ? nativeModule.isConnected() : false;
}

export function subscribeToCarPlayConnection(listener: (connected: boolean) => void) {
  if (!emitter) return () => undefined;
  const subscription = emitter.addListener('TaskHandoffCarPlayConnectionChanged', (event: { connected?: unknown }) => {
    listener(event.connected === true);
  });
  return () => subscription.remove();
}
