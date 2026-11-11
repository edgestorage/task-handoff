import { requireOptionalNativeModule } from 'expo';

import type {
  RemoteDesktopCodecConfig,
  RemoteDesktopDecoderError,
} from './RemoteDesktopDecoder.types';

type NativeRemoteDesktopModule = {
  isAvailable(): boolean;
  configure(config: RemoteDesktopCodecConfig): Promise<void>;
  decode(data: Uint8Array, keyframe: boolean, timestampUs: number): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
  startTextInputObservation(nativeID: string): boolean;
  stopTextInputObservation(): void;
  addListener?(name: 'onRemoteDesktopDecoderError', listener: (event: RemoteDesktopDecoderError) => void): { remove(): void };
  addListener?(name: 'onRemoteDesktopTextInput', listener: (event: RemoteDesktopTextInputEvent) => void): { remove(): void };
};

export type RemoteDesktopTextInputEvent = { text: string; composing: boolean };

const native = requireOptionalNativeModule<NativeRemoteDesktopModule>('TaskHandoffRemoteDesktop');

export const nativeRemoteDesktopDecoderAvailable = native?.isAvailable?.() === true;
export const nativeRemoteDesktopTextInputAvailable = typeof native?.startTextInputObservation === 'function';

export function subscribeRemoteDesktopDecoderErrors(listener: (event: RemoteDesktopDecoderError) => void) {
  try { return native?.addListener?.('onRemoteDesktopDecoderError', listener); }
  catch { return undefined; }
}

export async function configureRemoteDesktopDecoder(config: RemoteDesktopCodecConfig) {
  if (!native) throw Object.assign(new Error('The native remote desktop decoder is unavailable.'), { code: 'REMOTE_DESKTOP_DECODER_UNAVAILABLE' });
  await native.configure(config);
}

export async function decodeRemoteDesktopFrame(data: Uint8Array, keyframe: boolean, timestampUs: number) {
  if (!native) return;
  await native.decode(data, keyframe, timestampUs);
}

export async function resetRemoteDesktopDecoder() {
  await native?.reset();
}

export async function closeRemoteDesktopDecoder() {
  await native?.close();
}

export function startRemoteDesktopTextInputObservation(nativeID: string) {
  try { return native?.startTextInputObservation?.(nativeID) === true; }
  catch { return false; }
}

export function stopRemoteDesktopTextInputObservation() {
  try { native?.stopTextInputObservation?.(); }
  catch { /* the screen may be tearing down with the native module */ }
}

export function subscribeRemoteDesktopTextInput(listener: (event: RemoteDesktopTextInputEvent) => void) {
  try { return native?.addListener?.('onRemoteDesktopTextInput', listener); }
  catch { return undefined; }
}
