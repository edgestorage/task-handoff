import { requireOptionalNativeModule } from 'expo';

import type {
  RemoteDesktopCodecConfig,
  RemoteDesktopDecoderError,
  RemoteDesktopVideoDimensions,
} from './RemoteDesktopDecoder.types';

type NativeRemoteDesktopModule = {
  isAvailable(): boolean;
  configure(config: RemoteDesktopCodecConfig): Promise<void>;
  decode(data: Uint8Array, keyframe: boolean, timestampUs: number): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
  getLandscapeSide?(): RemoteDesktopLandscapeSide | null;
  startTextInputObservation(nativeID: string): boolean;
  stopTextInputObservation(): void;
  addListener?(name: 'onRemoteDesktopDecoderError', listener: (event: RemoteDesktopDecoderError) => void): { remove(): void };
  addListener?(name: 'onRemoteDesktopVideoDimensions', listener: (event: RemoteDesktopVideoDimensions) => void): { remove(): void };
  addListener?(name: 'onRemoteDesktopTextInput', listener: (event: RemoteDesktopTextInputEvent) => void): { remove(): void };
  addListener?(name: 'onRemoteDesktopOrientationChange', listener: (event: RemoteDesktopOrientationEvent) => void): { remove(): void };
};

export type RemoteDesktopTextInputEvent = { text: string; composing: boolean };
export type RemoteDesktopLandscapeSide = 'left' | 'right';
export type RemoteDesktopOrientationEvent = { side: RemoteDesktopLandscapeSide };

const native = requireOptionalNativeModule<NativeRemoteDesktopModule>('TaskHandoffRemoteDesktop');

export const nativeRemoteDesktopDecoderAvailable = native?.isAvailable?.() === true;
export const nativeRemoteDesktopTextInputAvailable = typeof native?.startTextInputObservation === 'function';

export function subscribeRemoteDesktopDecoderErrors(listener: (event: RemoteDesktopDecoderError) => void) {
  try { return native?.addListener?.('onRemoteDesktopDecoderError', listener); }
  catch { return undefined; }
}

export function subscribeRemoteDesktopVideoDimensions(listener: (event: RemoteDesktopVideoDimensions) => void) {
  try { return native?.addListener?.('onRemoteDesktopVideoDimensions', listener); }
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

export function currentRemoteDesktopLandscapeSide() {
  try { return native?.getLandscapeSide?.() ?? undefined; }
  catch { return undefined; }
}

export function subscribeRemoteDesktopOrientation(listener: (side: RemoteDesktopLandscapeSide) => void) {
  try { return native?.addListener?.('onRemoteDesktopOrientationChange', (event) => listener(event.side)); }
  catch { return undefined; }
}
